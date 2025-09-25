/* eslint-disable */
const { Plugin, PluginSettingTab, Setting, ItemView, Notice, TFile } = require("obsidian");
const http = require("http");

// ---------- Constants ----------
const VIEW_TYPE_SPOTIFY = "spotify-playback-view";
const REDIRECT_URI = "http://127.0.0.1:4370/callback";
const POLL_MS = 5000;                 // playback poll interval
const TOKEN_REFRESH_MS = 50 * 60e3;   // 50 minutes

// Spotify scopes needed for playback + state
const OAUTH_SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-library-read"
].join(" ");

// ---------- Helpers ----------
function sanitizeForTag(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\- ]/gi, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

// ---------- Plugin ----------
module.exports = class SpotifyPlaybackHelper extends Plugin {
  async onload() {
    console.log("Loading Spotify Playback Helper");

    this.settings = Object.assign(
      {
        clientId: "",
        clientSecret: "",
        accessToken: "",
        refreshToken: "",
        logListening: true,
        logFile: "Spotify Listening Log.md",
        showAlbumArt: true,
        showTrackTime: true,
        showControls: true,
        showShuffle: true,
        showRepeat: true,
        showPrevNext: true
      },
      (await this.loadData()) || {}
    );

    // Logging/session state
    this.prevTrackId = null;
    this.prevProgress = 0;
    this.readyToLog = true;           // becomes true at the start of a new play session
    this.lastLoggedTrackId = null;    // last track we actually wrote to the log
    this.lastLoggedAt = 0;            // timestamp of last log write

    // Register the view and settings
    this.registerView(VIEW_TYPE_SPOTIFY, (leaf) => new SpotifyView(leaf, this));
    this.addSettingTab(new SpotifySettingTab(this.app, this));

    // Ribbon
    this.addRibbonIcon("play", "Spotify Player", () => this.activateView());

    // Intervals
    this.registerInterval(window.setInterval(() => this.syncNowPlaying(), POLL_MS));
    this.registerInterval(window.setInterval(() => this.refreshAccessToken().catch(() => {}), TOKEN_REFRESH_MS));

    // Initial sync
    this.syncNowPlaying();
  }

  onunload() {
    console.log("Unloading Spotify Playback Helper");
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SPOTIFY);
  }

  async activateView() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SPOTIFY);
    await this.app.workspace.getRightLeaf(false).setViewState({ type: VIEW_TYPE_SPOTIFY, active: true });
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SPOTIFY)[0];
    if (leaf) this.app.workspace.revealLeaf(leaf);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---------- OAuth ----------
  async startAuthFlow() {
    if (!this.settings.clientId || !this.settings.clientSecret) {
      new Notice("Set your Client ID and Client Secret first.");
      return;
    }

    // Launch local callback server
    const server = http.createServer(async (req, res) => {
      try {
        if (req.url && req.url.startsWith("/callback")) {
          const url = new URL(req.url, REDIRECT_URI);
          const code = url.searchParams.get("code");
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h3>Spotify login successful. You can close this window.</h3>");
          server.close();
          if (code) await this.exchangeCodeForToken(code);
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch (e) {
        console.error("Auth callback error:", e);
        res.writeHead(500);
        res.end("Auth error");
        try { server.close(); } catch (_) {}
      }
    });
    server.listen(4370, "127.0.0.1");

    // Build auth URL
    const authUrl = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
      client_id: this.settings.clientId,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: OAUTH_SCOPES
    }).toString();

    try {
      const electron = require("electron");
      electron.shell.openExternal(authUrl);
    } catch (_) {
      window.open(authUrl, "_blank");
    }
  }

  async exchangeCodeForToken(code) {
    const params = new URLSearchParams();
    params.append("grant_type", "authorization_code");
    params.append("code", code);
    params.append("redirect_uri", REDIRECT_URI);

    const auth = btoa(`${this.settings.clientId}:${this.settings.clientSecret}`);

    try {
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params
      });

      if (!res.ok) {
        console.error("Token exchange failed:", await res.text());
        new Notice("Spotify token exchange failed (see console).");
        return;
      }
      const data = await res.json();
      this.settings.accessToken = data.access_token || "";
      this.settings.refreshToken = data.refresh_token || this.settings.refreshToken || "";
      await this.saveSettings();
      new Notice("Spotify authentication successful!");
      this.syncNowPlaying();
    } catch (e) {
      console.error("Token exchange error:", e);
      new Notice("Spotify token exchange error (see console).");
    }
  }

  async refreshAccessToken() {
    if (!this.settings.refreshToken) return false;

    const params = new URLSearchParams();
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", this.settings.refreshToken);

    const auth = btoa(`${this.settings.clientId}:${this.settings.clientSecret}`);

    try {
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params
      });

      if (!res.ok) {
        console.error("Failed to refresh token:", await res.text());
        return false;
      }
      const data = await res.json();
      if (data.access_token) {
        this.settings.accessToken = data.access_token;
        if (data.refresh_token) this.settings.refreshToken = data.refresh_token;
        await this.saveSettings();
        console.log("Spotify access token refreshed");
      }
      return true;
    } catch (e) {
      console.error("refreshAccessToken error:", e);
      return false;
    }
  }

  // ---------- Spotify API Wrapper ----------
  async spotifyApiCall(method, endpoint, body) {
    if (!this.settings.accessToken) return null;

    try {
      const res = await fetch(`https://api.spotify.com/v1/${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.settings.accessToken}`,
          "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
      });

      // Attempt token refresh on 401
      if (res.status === 401) {
        const ok = await this.refreshAccessToken();
        if (ok) {
          return this.spotifyApiCall(method, endpoint, body);
        }
        return null;
      }

      if (res.status === 204) return null;
      if (!res.ok) {
        console.error("Spotify API error", res.status, await res.text());
        return null;
      }
      return await res.json();
    } catch (e) {
      console.error("spotifyApiCall error:", e);
      return null;
    }
  }

  // ---------- Playback Sync ----------
  async syncNowPlaying() {
    // Use /me/player for complete state (shuffle/repeat/device/progress)
    const data = await this.spotifyApiCall("GET", "me/player");
    if (!data || !data.item) {
      // Clear session markers so next song logs normally
      this.prevTrackId = null;
      this.prevProgress = 0;
      this.readyToLog = true;

      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SPOTIFY)) {
        if (leaf.view?.showMessage) leaf.view.showMessage("Nothing is playing right now.");
      }
      return;
    }

    // Logging (only on nearly-complete plays, and only once per play session)
    if (this.settings.logListening && data.is_playing) {
      try {
        await this.maybeLogTrack(data);
      } catch (e) {
        console.error("maybeLogTrack error:", e);
      }
    }

    // Update UI
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SPOTIFY)) {
      if (leaf.view?.updateNowPlaying) leaf.view.updateNowPlaying(data);
    }
  }

  /**
   * Robust logging logic:
   * - Detect "new play session" when track changes OR progress wraps backwards (replay).
   * - Only log when progress >= 90% of duration AND we haven't logged this play yet (readyToLog).
   * - After logging, set readyToLog=false and wait for a new play session before logging again.
   * - Skipped tracks (<90%) are ignored completely.
   */
  async maybeLogTrack(player) {
    const item = player.item;
    const id = item?.id;
    const progress = player.progress_ms ?? 0;
    const duration = item?.duration_ms ?? 0;

    if (!id || duration <= 0) return;

    // Detect new play session:
    // 1) New track ID, or
    // 2) Same track but progress went backwards significantly (replay or manual scrub to start)
    const isNewTrack = this.prevTrackId && id !== this.prevTrackId;
    const rewound = !isNewTrack && (progress + 5000 < this.prevProgress); // 5s tolerance

    if (!this.prevTrackId || isNewTrack || rewound) {
      this.readyToLog = true;
      this.prevTrackId = id;
      this.prevProgress = progress;
    } else {
      this.prevProgress = progress;
    }

    // Only log when >= 90% played and we are allowed to log this play session
    const nearlyComplete = progress >= Math.floor(duration * 0.9);
    if (!nearlyComplete || !this.readyToLog) return;

    // Prevent extremely rapid duplicate logs for the same track even if replay spun up instantly.
    // Require at least 20 seconds between logs of the same track.
    const now = Date.now();
    if (this.lastLoggedTrackId === id && (now - this.lastLoggedAt) < 20000) {
      // Too soon since last log of same track; ignore
      return;
    }

    await this.logTableIncrement(item);

    // Mark this play session as logged
    this.readyToLog = false;
    this.lastLoggedTrackId = id;
    this.lastLoggedAt = now;
  }

  // ---------- Listening Log (single persistent table) ----------
  async logTableIncrement(track) {
    const filePath = this.settings.logFile || "Spotify Listening Log.md";
    const file = this.app.vault.getAbstractFileByPath(filePath);

    const artistsReadable = (track.artists || []).map((a) => a.name).join(", ");
    const trackReadable = track.name || "";
    const artistTags = (track.artists || []).map((a) => `#artist/${sanitizeForTag(a.name)}`).join(" ");
    const trackTag = `#track/${sanitizeForTag(track.name || "")}`;
    const tags = `${artistTags} ${trackTag}`.trim();
    const durationMinutes = Math.max(1, Math.round((track.duration_ms || 0) / 60000));

    // Load existing rows
    let rows = [];
    if (file instanceof TFile) {
      const content = await this.app.vault.read(file);
      const lines = content.split("\n").map((l) => l.trimEnd());
      const hasHeader = lines.length >= 2 && lines[0].toLowerCase().includes("track | artist");

      if (hasHeader) {
        const body = lines.slice(2);
        for (const line of body) {
          if (!line || !line.startsWith("|")) continue;
          const parts = line.split("|").map((p) => p.trim());
          // Expect: | Track | Artist(s) | Times Played | Time Listened (min) | Tags |
          // indexes: 0    1         2         3                4                 5
          if (parts.length >= 6) {
            rows.push([parts[1], parts[2], parts[3], parts[4], parts[5]]);
          }
        }
      }
    }

    // Update or insert row
    const idx = rows.findIndex((r) => r[0] === trackReadable && r[1] === artistsReadable);
    if (idx >= 0) {
      const timesPlayed = (parseInt(rows[idx][2]) || 0) + 1;
      const timeListened = (parseInt(rows[idx][3]) || 0) + durationMinutes;
      rows[idx] = [trackReadable, artistsReadable, timesPlayed, timeListened, tags];
    } else {
      rows.push([trackReadable, artistsReadable, 1, durationMinutes, tags]);
    }

    // Rebuild table content
    const out = [];
    out.push("| Track | Artist(s) | Times Played | Time Listened (min) | Tags |");
    out.push("|-------|-----------|--------------|---------------------|------|");
    for (const r of rows) {
      out.push(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} |`);
    }

    if (file instanceof TFile) {
      await this.app.vault.modify(file, out.join("\n"));
    } else {
      await this.app.vault.create(filePath, out.join("\n"));
    }
  }

  // ---------- UI Refresh Helper ----------
  notifySettingChange() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SPOTIFY)) {
      const v = leaf.view;
      if (v?.lastData && v.updateNowPlaying) v.updateNowPlaying(v.lastData);
    }
  }
};

// ---------- View ----------
class SpotifyView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.lastData = null;
    this.progressTimer = null;
  }

  getViewType() { return VIEW_TYPE_SPOTIFY; }
  getDisplayText() { return "Spotify Player"; }

  async onOpen() {
    this.containerEl.empty();
    this.contentEl = this.containerEl.createDiv({ cls: "spotify-view" });
    this.showMessage("Loading Spotify…");
  }

  onunload() {
    this.clearTimer();
  }

  showMessage(msg) {
    this.contentEl.empty();
    this.contentEl.createDiv({ text: msg });
    this.clearTimer();
  }

  clearTimer() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  async updateNowPlaying(data) {
    this.lastData = data;
    this.contentEl.empty();

    const track = data.item;
    if (!track) {
      this.showMessage("Nothing is playing.");
      return;
    }

    // Album art
    if (this.plugin.settings.showAlbumArt && track.album?.images?.length) {
      const img = this.contentEl.createEl("img", { attr: { src: track.album.images[0].url } });
      img.style.maxWidth = "100%";
      img.style.borderRadius = "8px";
      img.style.marginBottom = "8px";
    }

    // Text
    this.contentEl.createEl("h4", { text: track.name });
    this.contentEl.createEl("div", { text: (track.artists || []).map((a) => a.name).join(", ") });

    // Track time + progress bar
    if (this.plugin.settings.showTrackTime) {
      const timeDiv = this.contentEl.createDiv({ cls: "spotify-time" });
      const progressBar = this.contentEl.createEl("progress", {
        attr: { max: track.duration_ms || 0, value: data.progress_ms || 0 }
      });
      progressBar.style.width = "100%";
      progressBar.style.height = "8px";
      progressBar.style.marginTop = "4px";

      let progress = data.progress_ms || 0;
      const duration = track.duration_ms || 0;

      const updateTime = () => {
        const mins = Math.floor(progress / 60000);
        const secs = Math.floor((progress % 60000) / 1000);
        const dMins = Math.floor(duration / 60000);
        const dSecs = Math.floor((duration % 60000) / 1000);
        timeDiv.setText(`${mins}:${String(secs).padStart(2, "0")} / ${dMins}:${String(dSecs).padStart(2, "0")}`);
        progressBar.value = progress;
      };

      updateTime();
      this.clearTimer();
      if (data.is_playing) {
        this.progressTimer = setInterval(() => {
          progress += 1000;
          if (progress > duration) {
            this.clearTimer();
          } else {
            updateTime();
          }
        }, 1000);
      }
    }

    // Controls
    if (this.plugin.settings.showControls) {
      const controls = this.contentEl.createDiv({ cls: "spotify-controls" });
      controls.style.display = "flex";
      controls.style.gap = "6px";
      controls.style.marginTop = "8px";

      // Prev
      if (this.plugin.settings.showPrevNext) {
        const prevBtn = controls.createEl("button", { text: "⏮" });
        prevBtn.onclick = async () => {
          await this.plugin.spotifyApiCall("POST", "me/player/previous");
          this.plugin.syncNowPlaying();
        };
      }

      // Play/Pause
      const playPauseBtn = controls.createEl("button", { text: data.is_playing ? "⏸" : "▶" });
      playPauseBtn.onclick = async () => {
        await this.plugin.spotifyApiCall("PUT", `me/player/${data.is_playing ? "pause" : "play"}`);
        this.plugin.syncNowPlaying();
      };

      // Next
      if (this.plugin.settings.showPrevNext) {
        const nextBtn = controls.createEl("button", { text: "⏭" });
        nextBtn.onclick = async () => {
          await this.plugin.spotifyApiCall("POST", "me/player/next");
          this.plugin.syncNowPlaying();
        };
      }

      // Shuffle
      if (this.plugin.settings.showShuffle) {
        const shuffleBtn = controls.createEl("button", { text: data.shuffle_state ? "🔀 On" : "🔀 Off" });
        shuffleBtn.onclick = async () => {
          await this.plugin.spotifyApiCall("PUT", `me/player/shuffle?state=${!data.shuffle_state}`);
          this.plugin.syncNowPlaying();
        };
      }

      // Repeat
      if (this.plugin.settings.showRepeat) {
        const repeatBtn = controls.createEl("button", {
          text: data.repeat_state === "off" ? "🔁 Off" : data.repeat_state === "track" ? "🔂 Track" : "🔁 All"
        });
        repeatBtn.onclick = async () => {
          const nextMode = data.repeat_state === "off" ? "context" : (data.repeat_state === "context" ? "track" : "off");
          await this.plugin.spotifyApiCall("PUT", `me/player/repeat?state=${nextMode}`);
          this.plugin.syncNowPlaying();
        };
      }
    }
  }
}

// ---------- Settings ----------
class SpotifySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Spotify Playback Helper Settings" });

    // Client ID (masked)
    new Setting(containerEl)
      .setName("Client ID")
      .setDesc("Your Spotify App Client ID. Field is masked; re-enter to change.")
      .addText((t) =>
        t
          .setPlaceholder("Enter Client ID")
          .setValue(this.plugin.settings.clientId ? "********" : "")
          .onChange(async (val) => {
            if (val && val !== "********") {
              this.plugin.settings.clientId = val.trim();
              await this.plugin.saveSettings();
            }
          })
      );

    // Client Secret (masked)
    new Setting(containerEl)
      .setName("Client Secret")
      .setDesc("Your Spotify App Client Secret. Field is masked; re-enter to change.")
      .addText((t) =>
        t
          .setPlaceholder("Enter Client Secret")
          .setValue(this.plugin.settings.clientSecret ? "********" : "")
          .onChange(async (val) => {
            if (val && val !== "********") {
              this.plugin.settings.clientSecret = val.trim();
              await this.plugin.saveSettings();
            }
          })
      );

    // Login
    new Setting(containerEl)
      .setName("Login with Spotify")
      .setDesc("Authenticate and retrieve tokens automatically.")
      .addButton((btn) => btn.setButtonText("Login").onClick(() => this.plugin.startAuthFlow()));

    // Log toggle
    new Setting(containerEl)
      .setName("Listening Log")
      .setDesc("Only fully played tracks (≥ 90%) are logged. Skips are ignored.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.logListening).onChange(async (val) => {
          this.plugin.settings.logListening = val;
          await this.plugin.saveSettings();
        })
      );

    // Log file
    new Setting(containerEl)
      .setName("Listening Log File")
      .setDesc("Markdown file where the single table is stored.")
      .addText((text) =>
        text
          .setPlaceholder("Spotify Listening Log.md")
          .setValue(this.plugin.settings.logFile)
          .onChange(async (val) => {
            this.plugin.settings.logFile = val.trim();
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Display Options" });

    new Setting(containerEl)
      .setName("Show Album Art")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showAlbumArt).onChange(async (val) => {
          this.plugin.settings.showAlbumArt = val;
          await this.plugin.saveSettings();
          this.plugin.notifySettingChange();
        })
      );

    new Setting(containerEl)
      .setName("Show Track Time")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showTrackTime).onChange(async (val) => {
          this.plugin.settings.showTrackTime = val;
          await this.plugin.saveSettings();
          this.plugin.notifySettingChange();
        })
      );

    new Setting(containerEl)
      .setName("Show Controls")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showControls).onChange(async (val) => {
          this.plugin.settings.showControls = val;
          await this.plugin.saveSettings();
          this.plugin.notifySettingChange();
        })
      );

    new Setting(containerEl)
      .setName("Show Shuffle Button")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showShuffle).onChange(async (val) => {
          this.plugin.settings.showShuffle = val;
          await this.plugin.saveSettings();
          this.plugin.notifySettingChange();
        })
      );

    new Setting(containerEl)
      .setName("Show Repeat Button")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showRepeat).onChange(async (val) => {
          this.plugin.settings.showRepeat = val;
          await this.plugin.saveSettings();
          this.plugin.notifySettingChange();
        })
      );

    new Setting(containerEl)
      .setName("Show Previous/Next Buttons")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showPrevNext).onChange(async (val) => {
          this.plugin.settings.showPrevNext = val;
          await this.plugin.saveSettings();
          this.plugin.notifySettingChange();
        })
      );
  }
}
