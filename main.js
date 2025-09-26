/* eslint-disable */
const { Plugin, PluginSettingTab, Setting, ItemView, Notice, TFile } = require("obsidian");
const http = require("http");

const VIEW_TYPE_SPOTIFY = "spotify-playback-view";
const REDIRECT_URI = "http://127.0.0.1:8888/callback";
const POLL_MS = 5000;
const TOKEN_REFRESH_MS = 50 * 60e3; // 50 minutes

const OAUTH_SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-library-read",
].join(" ");

function sanitizeForTag(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\- ]/gi, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

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
        showPrevNext: true,
      },
      (await this.loadData()) || {}
    );

    // logging state
    this.prevTrackId = null;
    this.prevProgress = 0;
    this.readyToLog = true;
    this.lastLoggedTrackId = null;
    this.lastLoggedAt = 0;

    this.registerView(VIEW_TYPE_SPOTIFY, (leaf) => new SpotifyView(leaf, this));
    this.addSettingTab(new SpotifySettingTab(this.app, this));
    this.addRibbonIcon("play", "Spotify Player", () => this.activateView());

    // intervals
    this.registerInterval(window.setInterval(() => this.syncNowPlaying(), POLL_MS));
    this.registerInterval(window.setInterval(() => this.refreshAccessToken().catch(() => {}), TOKEN_REFRESH_MS));

    // initial sync
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

  async saveSettings() { await this.saveData(this.settings); }

  // ===== OAuth =====
  async startAuthFlow() {
    if (!this.settings.clientId || !this.settings.clientSecret) {
      new Notice("Set your Client ID and Secret first.");
      return;
    }

    const server = http.createServer(async (req, res) => {
      if (req.url && req.url.startsWith("/callback")) {
        try {
          const url = new URL(req.url, REDIRECT_URI);
          const code = url.searchParams.get("code");
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h3>Spotify login successful. You can close this window.</h3>");
          server.close();
          if (code) await this.exchangeCodeForToken(code);
        } catch (e) { console.error("Auth callback error", e); }
      } else {
        res.writeHead(404); res.end();
      }
    });
    server.listen(4370, "127.0.0.1");

    const authUrl = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
      client_id: this.settings.clientId,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: OAUTH_SCOPES,
    }).toString();

    try { require("electron").shell.openExternal(authUrl); }
    catch (_) { window.open(authUrl, "_blank"); }
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
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      });
      if (!res.ok) {
        console.error("Token exchange failed:", await res.text());
        new Notice("Spotify token exchange failed.");
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
      new Notice("Spotify token exchange error.");
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
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
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
      }
      return true;
    } catch (e) {
      console.error("refreshAccessToken error:", e);
      return false;
    }
  }

  // ===== Spotify API helper =====
  async spotifyApiCall(method, endpoint, body) {
    if (!this.settings.accessToken) return null;
    try {
      const res = await fetch(`https://api.spotify.com/v1/${endpoint}`, {
        method,
        headers: { Authorization: `Bearer ${this.settings.accessToken}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401) {
        if (await this.refreshAccessToken()) return this.spotifyApiCall(method, endpoint, body);
        return null;
      }
      if (res.status === 204) return null;
      if (!res.ok) {
        console.error("Spotify API error:", res.status, await res.text());
        return null;
      }
      return await res.json();
    } catch (e) {
      console.error("spotifyApiCall error:", e);
      return null;
    }
  }

  // ===== Poll & update UI =====
  async syncNowPlaying() {
    const data = await this.spotifyApiCall("GET", "me/player");
    if (!data || !data.item) {
      this.prevTrackId = null;
      this.prevProgress = 0;
      this.readyToLog = true;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SPOTIFY)) {
        if (leaf.view?.showMessage) leaf.view.showMessage("Nothing is playing right now.");
      }
      return;
    }

    if (this.settings.logListening && data.is_playing) {
      await this.maybeLogTrack(data);
    }

    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SPOTIFY)) {
      if (leaf.view?.updateNowPlaying) leaf.view.updateNowPlaying(data);
    }
  }

  // ===== Logging logic (≥90% only, no duplicates, skips ignored) =====
  async maybeLogTrack(player) {
    const item = player.item;
    const id = item?.id;
    const progress = player.progress_ms ?? 0;
    const duration = item?.duration_ms ?? 0;
    if (!id || duration <= 0) return;

    const isNewTrack = this.prevTrackId && id !== this.prevTrackId;
    const rewound = !isNewTrack && (progress + 5000 < this.prevProgress); // 5s tolerance

    if (!this.prevTrackId || isNewTrack || rewound) {
      this.readyToLog = true;
      this.prevTrackId = id;
      this.prevProgress = progress;
    } else {
      this.prevProgress = progress;
    }

    const nearlyComplete = progress >= Math.floor(duration * 0.9);
    if (!nearlyComplete || !this.readyToLog) return;

    const now = Date.now();
    if (this.lastLoggedTrackId === id && (now - this.lastLoggedAt) < 20000) return;

    await this.logTableIncrement(item);
    this.readyToLog = false;
    this.lastLoggedTrackId = id;
    this.lastLoggedAt = now;
  }

  async logTableIncrement(track) {
    const filePath = this.settings.logFile || "Spotify Listening Log.md";
    const file = this.app.vault.getAbstractFileByPath(filePath);

    const artistsReadable = (track.artists || []).map((a) => a.name).join(", ");
    const trackReadable = track.name || "";
    const artistTags = (track.artists || []).map((a) => `#artist/${sanitizeForTag(a.name)}`).join(" ");
    const trackTag = `#track/${sanitizeForTag(track.name || "")}`;
    const tags = `${artistTags} ${trackTag}`.trim();
    const durationMinutes = Math.max(1, Math.round((track.duration_ms || 0) / 60000));

    // Read existing rows from table (robust)
    let rows = [];
    if (file instanceof TFile) {
      const content = await this.app.vault.read(file);
      const lines = content.split("\n").map((l) => l.trimEnd());
      // only keep table body rows that start with '|' and aren't separators
      const body = lines.filter((l) => l.startsWith("|") && !l.includes("---"));
      for (const line of body) {
        const parts = line.split("|").map((p) => p.trim());
        // parts: ["", Track, Artist(s), Times, Time(min), Tags, ""]
        if (parts.length >= 6 && parts[0] === "" && parts[1] !== "Track") {
          rows.push([parts[1], parts[2], parts[3], parts[4], parts[5]]);
        }
      }
    }

    // merge/update target row
    const idx = rows.findIndex((r) => r[0] === trackReadable && r[1] === artistsReadable);
    if (idx >= 0) {
      const timesPlayed = (parseInt(rows[idx][2]) || 0) + 1;
      const timeListened = (parseInt(rows[idx][3]) || 0) + durationMinutes;
      rows[idx] = [trackReadable, artistsReadable, String(timesPlayed), String(timeListened), tags];
    } else {
      rows.push([trackReadable, artistsReadable, "1", String(durationMinutes), tags]);
    }

    const out = [
      "| Track | Artist(s) | Times Played | Time Listened (min) | Tags |",
      "|-------|-----------|--------------|---------------------|------|",
      ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} |`),
    ];

    if (file instanceof TFile) await this.app.vault.modify(file, out.join("\n"));
    else await this.app.vault.create(filePath, out.join("\n"));
  }

  notifySettingChange() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SPOTIFY)) {
      const v = leaf.view;
      if (v?.lastData && v.updateNowPlaying) v.updateNowPlaying(v.lastData);
    }
  }
};

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

  onunload() { this.clearTimer(); }

  showMessage(msg) {
    this.contentEl.empty();
    this.contentEl.createDiv({ text: msg });
    this.clearTimer();
  }

  clearTimer() {
    if (this.progressTimer) { clearInterval(this.progressTimer); this.progressTimer = null; }
  }

  async updateNowPlaying(data) {
    this.lastData = data;
    this.contentEl.empty();

    const track = data.item;
    if (!track) { this.showMessage("Nothing is playing."); return; }

    // Album art
    if (this.plugin.settings.showAlbumArt && track.album?.images?.length) {
      const img = this.contentEl.createEl("img", { attr: { src: track.album.images[0].url } });
      img.style.maxWidth = "100%";
      img.style.borderRadius = "8px";
      img.style.marginBottom = "8px";
      img.style.boxShadow = "0 2px 8px rgba(0,0,0,0.25)";
    }

    // Title & artist(s)
    this.contentEl.createEl("h4", { text: track.name });
    this.contentEl.createEl("div", { text: (track.artists || []).map((a) => a.name).join(", ") });

    // Time + progress bar
    if (this.plugin.settings.showTrackTime) {
      const timeDiv = this.contentEl.createDiv({ cls: "spotify-time" });
      const progressBar = this.contentEl.createDiv({ cls: "spotify-progress-bar" });
      const progressFill = progressBar.createDiv({ cls: "spotify-progress" });

      let progress = data.progress_ms || 0;
      const duration = track.duration_ms || 0;

      const updateTime = () => {
        const mins = Math.floor(progress / 60000);
        const secs = Math.floor((progress % 60000) / 1000);
        const dMins = Math.floor(duration / 60000);
        const dSecs = Math.floor((duration % 60000) / 1000);
        timeDiv.setText(`${mins}:${String(secs).padStart(2, "0")} / ${dMins}:${String(dSecs).padStart(2, "0")}`);
        const percent = duration ? Math.min(100, Math.floor((progress / duration) * 100)) : 0;
        progressFill.style.width = percent + "%";
      };

      updateTime();
      this.clearTimer();
      if (data.is_playing) {
        this.progressTimer = setInterval(() => {
          progress += 1000;
          if (progress > duration) this.clearTimer();
          else updateTime();
        }, 1000);
      }
    }

    // Controls
    if (this.plugin.settings.showControls) {
      const controls = this.contentEl.createDiv({ cls: "spotify-controls" });

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
        const label =
          data.repeat_state === "off" ? "🔁 Off" :
          data.repeat_state === "track" ? "🔂 Track" : "🔁 All";
        const repeatBtn = controls.createEl("button", { text: label });
        repeatBtn.onclick = async () => {
          const nextMode =
            data.repeat_state === "off" ? "context" :
            (data.repeat_state === "context" ? "track" : "off");
          await this.plugin.spotifyApiCall("PUT", `me/player/repeat?state=${nextMode}`);
          this.plugin.syncNowPlaying();
        };
      }
    }
  }
}

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
      .setDesc("Field is masked; re-enter to change.")
      .addText((t) =>
        t.setPlaceholder("Enter Client ID")
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
      .setDesc("Field is masked; re-enter to change.")
      .addText((t) =>
        t.setPlaceholder("Enter Client Secret")
          .setValue(this.plugin.settings.clientSecret ? "********" : "")
          .onChange(async (val) => {
            if (val && val !== "********") {
              this.plugin.settings.clientSecret = val.trim();
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Login with Spotify")
      .setDesc("Authenticate and retrieve tokens automatically.")
      .addButton((btn) => btn.setButtonText("Login").onClick(() => this.plugin.startAuthFlow()));

    new Setting(containerEl)
      .setName("Listening Log")
      .setDesc("Only near-complete plays (≥ 90%) are logged; skips ignored.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.logListening).onChange(async (val) => {
          this.plugin.settings.logListening = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Listening Log File")
      .setDesc("Markdown file that stores a single, persistent table.")
      .addText((text) =>
        text.setPlaceholder("Spotify Listening Log.md")
            .setValue(this.plugin.settings.logFile)
            .onChange(async (val) => {
              this.plugin.settings.logFile = val.trim();
              await this.plugin.saveSettings();
            })
      );

    containerEl.createEl("h3", { text: "Display Options" });

    new Setting(containerEl).setName("Show Album Art").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showAlbumArt).onChange(async (val) => {
        this.plugin.settings.showAlbumArt = val;
        await this.plugin.saveSettings();
        this.plugin.notifySettingChange();
      })
    );

    new Setting(containerEl).setName("Show Track Time").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showTrackTime).onChange(async (val) => {
        this.plugin.settings.showTrackTime = val;
        await this.plugin.saveSettings();
        this.plugin.notifySettingChange();
      })
    );

    new Setting(containerEl).setName("Show Controls").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showControls).onChange(async (val) => {
        this.plugin.settings.showControls = val;
        await this.plugin.saveSettings();
        this.plugin.notifySettingChange();
      })
    );

    new Setting(containerEl).setName("Show Shuffle Button").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showShuffle).onChange(async (val) => {
        this.plugin.settings.showShuffle = val;
        await this.plugin.saveSettings();
        this.plugin.notifySettingChange();
      })
    );

    new Setting(containerEl).setName("Show Repeat Button").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showRepeat).onChange(async (val) => {
        this.plugin.settings.showRepeat = val;
        await this.plugin.saveSettings();
        this.plugin.notifySettingChange();
      })
    );

    new Setting(containerEl).setName("Show Previous/Next Buttons").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showPrevNext).onChange(async (val) => {
        this.plugin.settings.showPrevNext = val;
        await this.plugin.saveSettings();
        this.plugin.notifySettingChange();
      })
    );
  }
}
