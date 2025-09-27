/* eslint-disable */
const { Plugin, PluginSettingTab, Setting, ItemView, Notice, TFile } = require("obsidian");
const http = require("http");

const VIEW_TYPE_SPOTIFY = "spotify-playback-view";
const REDIRECT_URI = "http://127.0.0.1:8888/callback";
const POLL_MS = 5000;
const TOKEN_REFRESH_MS = 50 * 60e3;

const OAUTH_SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-library-read",
].join(" ");

/* -------------------------- Utilities -------------------------- */

function sanitizeForTag(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9 \-]/gi, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function secsToMS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function msStringToSecs(msStr) {
  if (!msStr) return 0;
  const parts = String(msStr).trim().split(":");
  if (parts.length !== 2) return 0;
  const m = parseInt(parts[0], 10);
  const s = parseInt(parts[1], 10);
  if (isNaN(m) || isNaN(s)) return 0;
  return Math.max(0, m * 60 + s);
}

function normalizeTimeMS(msStr) {
  const secs = msStringToSecs(msStr);
  return secs > 0 ? secsToMS(secs) : "00:00";
}

function dedupeRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r[0]}||${r[1]}`;
    const times = parseInt(r[2], 10) || 0;
    const secs = msStringToSecs(r[3]);
    const tags = r[4] || "";
    if (!map.has(key)) {
      map.set(key, { track: r[0], artist: r[1], times, secs, tags });
    } else {
      const existing = map.get(key);
      existing.times += times;
      existing.secs += secs;
      const merged = new Set(
        (existing.tags + " " + tags)
          .split(" ")
          .map((t) => t.trim())
          .filter(Boolean)
      );
      existing.tags = Array.from(merged).join(" ");
    }
  }
  return Array.from(map.values()).map((v) => [
    v.track,
    v.artist,
    String(v.times),
    normalizeTimeMS(secsToMS(v.secs)),
    v.tags,
  ]);
}

function sortRows(rows, mode, ascending = false) {
  let sorted = rows;
  if (mode === "time") {
    sorted = rows.sort((a, b) => msStringToSecs(b[3]) - msStringToSecs(a[3]));
  } else if (mode === "plays") {
    sorted = rows.sort((a, b) => (parseInt(b[2], 10) || 0) - (parseInt(a[2], 10) || 0));
  }
  return ascending ? sorted.reverse() : sorted;
}

function isHeaderRow(line) {
  const clean = line.toLowerCase().replace(/\s+/g, " ");
  return clean.includes("track") && clean.includes("artist") && clean.includes("time");
}

function repairRow(parts) {
  const track = parts[1] || "Unknown track";
  const artist = parts[2] || "Unknown artist";
  const timesPlayed = parts[3] && !isNaN(parseInt(parts[3], 10)) ? parts[3] : "0";
  const timeStr = normalizeTimeMS(parts[4] || "00:00");
  const tags = parts[5] || "";
  return [track, artist, timesPlayed, timeStr, tags];
}

/* -------------------------- Main Plugin -------------------------- */

module.exports = class SpotifyPlayback extends Plugin {
  async onload() {
    this.settings = Object.assign(
      {
        clientId: "",
        clientSecret: "",
        accessToken: "",
        refreshToken: "",
        logListening: true,
        logFile: "Spotify listening log.md",
        showAlbumArt: true,
        showTrackTime: true,
        showControls: true,
        showShuffle: true,
        showRepeat: true,
        showPrevNext: true,
        logFormatVersion: 2,
        sortMode: "insertion",
        sortAscending: false,
      },
      (await this.loadData()) || {}
    );

    this.prevTrackId = null;
    this.prevProgress = 0;
    this.prevIsPlaying = false;
    this.lastItem = null;

    this.lastLoggedTrackId = null;
    this.lastLoggedAt = 0;

    this.registerView(VIEW_TYPE_SPOTIFY, (leaf) => new SpotifyView(leaf, this));
    this.addSettingTab(new SpotifySettingTab(this.app, this));
    this.addRibbonIcon("play", "Spotify player", () => this.activateView());

    await this.migrateOldLogFormat().catch(() => {});

    this.registerInterval(window.setInterval(() => this.syncNowPlaying(), POLL_MS));
    this.registerInterval(window.setInterval(() => this.refreshAccessToken().catch(() => {}), TOKEN_REFRESH_MS));

    this.syncNowPlaying();
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SPOTIFY);
  }

  async activateView() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SPOTIFY);
    await this.app.workspace.getRightLeaf(false).setViewState({ type: VIEW_TYPE_SPOTIFY, active: true });
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SPOTIFY)[0];
    if (leaf) this.app.workspace.revealLeaf(leaf);
  }

  async saveSettings() { await this.saveData(this.settings); }

  /* ---------------- OAuth + API ---------------- */

  async startAuthFlow() {
    if (this.settings.refreshToken) {
      await this.refreshAccessToken();
      new Notice("Spotify: Access token refreshed!");
      return;
    }

    const authUrl = `https://accounts.spotify.com/authorize?client_id=${this.settings.clientId}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(OAUTH_SCOPES)}`;
    window.open(authUrl, "_blank");

    const server = http.createServer(async (req, res) => {
      if (req.url.startsWith("/callback")) {
        const urlObj = new URL(req.url, "http://127.0.0.1:8888");
        const code = urlObj.searchParams.get("code");

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Spotify authentication complete! You can close this window.");

        server.close();

        if (code) {
          await this.exchangeCodeForTokens(code);
        }
      }
    });

    server.listen(8888, () => {
      console.log("Spotify: Listening for OAuth callback on http://127.0.0.1:8888/callback");
    });
  }

  async exchangeCodeForTokens(code) {
    try {
      const params = new URLSearchParams();
      params.append("grant_type", "authorization_code");
      params.append("code", code);
      params.append("redirect_uri", REDIRECT_URI);

      const authHeader = btoa(`${this.settings.clientId}:${this.settings.clientSecret}`);

      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Authorization": `Basic ${authHeader}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
      });

      if (!res.ok) {
        console.error("Spotify: Failed to exchange code", res.status, await res.text());
        new Notice("Spotify: Failed to login. Check console for details.");
        return;
      }

      const data = await res.json();

      if (data.access_token) this.settings.accessToken = data.access_token;
      if (data.refresh_token) this.settings.refreshToken = data.refresh_token;

      await this.saveSettings();
      new Notice("Spotify: Logged in successfully!");
    } catch (e) {
      console.error("Spotify: exchangeCodeForTokens error", e);
      new Notice("Spotify: Error during login. See console for details.");
    }
  }

  async refreshAccessToken() {
    if (!this.settings.refreshToken) {
      console.error("Spotify: No refresh token available.");
      new Notice("Spotify: No refresh token available. Please login again.");
      return false;
    }

    try {
      const params = new URLSearchParams();
      params.append("grant_type", "refresh_token");
      params.append("refresh_token", this.settings.refreshToken);

      const authHeader = btoa(`${this.settings.clientId}:${this.settings.clientSecret}`);

      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Authorization": `Basic ${authHeader}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
      });

      if (!res.ok) {
        console.error("Spotify: Failed to refresh token", res.status, await res.text());
        new Notice("Spotify: Failed to refresh token. Please login again.");
        return false;
      }

      const data = await res.json();

      if (data.access_token) {
        this.settings.accessToken = data.access_token;
        await this.saveSettings();
        console.log("Spotify: Access token refreshed.");
        return true;
      }

      return false;
    } catch (e) {
      console.error("Spotify: refreshAccessToken error", e);
      new Notice("Spotify: Error refreshing token. See console for details.");
      return false;
    }
  }

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
  
  /* ---------------- Sync + Logging ---------------- */

  async syncNowPlaying() {
    const data = await this.spotifyApiCall("GET", "me/player");
    const nowIsPlaying = !!data?.is_playing;
    const item = data?.item || null;
    const id = item?.id || null;
    const progress = data?.progress_ms ?? 0;

    const trackChanged = this.prevTrackId && id && id !== this.prevTrackId;
    const rewound = id && this.prevTrackId === id && progress + 2000 < this.prevProgress;
    const pausedNow = !nowIsPlaying && this.prevIsPlaying;

    if (trackChanged || rewound || pausedNow || (!id && this.prevTrackId)) {
      await this.finalizeSession();
    }

    this.prevIsPlaying = nowIsPlaying;
    this.prevTrackId = id;
    this.prevProgress = progress;
    if (item) this.lastItem = item;

    if (!data || !item) {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SPOTIFY)) {
        if (leaf.view?.showMessage) leaf.view.showMessage("Nothing is playing right now.");
      }
      return;
    }

    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SPOTIFY)) {
      if (leaf.view?.updateNowPlaying) leaf.view.updateNowPlaying(data);
    }
  }

  async finalizeSession() {
    const item = this.lastItem;
    if (!item) return;

    const duration = item?.duration_ms ?? 0;
    const durationSecs = Math.floor(duration / 1000);
    const progressSecs = Math.floor((this.prevProgress ?? 0) / 1000);

    if (progressSecs < 5) return;

    let incrementPlay = false;
    let logSecs = progressSecs;

    if (durationSecs > 0) {
      const ninetyPct = Math.floor(durationSecs * 0.9);
      if (progressSecs >= ninetyPct) {
        incrementPlay = true;
        logSecs = durationSecs;
      }
    }

    // Deduplication guard
    const now = Date.now();
    if (
      this.lastLoggedTrackId === item.id &&
      now - this.lastLoggedAt < 10000
    ) {
      return;
    }

    await this.logTableAmendExact(item, logSecs, incrementPlay);

    this.lastLoggedTrackId = item.id;
    this.lastLoggedAt = now;
  }

  async logTableAmendExact(track, addSeconds, incrementPlay) {
    const filePath = this.settings.logFile || "Spotify listening log.md";
    const file = this.app.vault.getAbstractFileByPath(filePath);

    const artistsReadable = (track.artists || []).map((a) => a.name).join(", ");
    const trackReadable = track.name || "";
    const artistTags = (track.artists || []).map((a) => `#artist/${sanitizeForTag(a.name)}`).join(" ");
    const trackTag = `#track/${sanitizeForTag(track.name || "")}`;
    const tags = `${artistTags} ${trackTag}`.trim();

    let rows = [];
    let headerLines = [
      "| Track | Artist(s) | Times played | Time listened (m:s) | Tags |",
      "|-------|-----------|--------------|---------------------|------|",
    ];

    let validHeader = false;

    if (file instanceof TFile) {
      const content = await this.app.vault.read(file);
      const lines = content.split("\n").map((l) => l.trimEnd());

      const headerIndex = lines.findIndex(isHeaderRow);
      if (headerIndex !== -1) {
        validHeader = true;
        const bodyLines = lines.slice(headerIndex + 2);
        for (const line of bodyLines) {
          if (!line.startsWith("|")) continue;
          const parts = line.split("|").map((p) => p.trim());
          rows.push(repairRow(parts));
        }
      }
    }

    const idx = rows.findIndex((r) => r[0] === trackReadable && r[1] === artistsReadable);
    if (idx >= 0) {
      const oldTimes = parseInt(rows[idx][2], 10) || 0;
      const oldSecs = msStringToSecs(rows[idx][3]);
      const newSecs = oldSecs + Math.max(0, addSeconds);
      const newMS = normalizeTimeMS(secsToMS(newSecs));
      const newTimes = incrementPlay ? oldTimes + 1 : oldTimes;
      rows[idx] = [rows[idx][0], rows[idx][1], String(newTimes), newMS, rows[idx][4] || tags];
    } else {
      rows.push([trackReadable, artistsReadable, incrementPlay ? "1" : "0", secsToMS(addSeconds), tags]);
    }

    rows = dedupeRows(rows);
    rows = sortRows(rows, this.settings.sortMode, this.settings.sortAscending);

    const table = [...headerLines, ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} |`)];

    if (file instanceof TFile) {
      const content = await this.app.vault.read(file);

      if (!validHeader) {
        await this.app.vault.modify(file, content + "\n\n" + table.join("\n"));
        new Notice("Spotify playback: created new log table (failsafe triggered).");
      } else {
        await this.app.vault.modify(file, table.join("\n"));
      }
    } else {
      await this.app.vault.create(filePath, table.join("\n"));
    }
  }

  /* ---- migrateOldLogFormat & resortLogFile methods from before ---- */

  async migrateOldLogFormat() {
    if (this.settings.logFormatVersion >= 2) return;
    const filePath = this.settings.logFile || "Spotify listening log.md";
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      this.settings.logFormatVersion = 2;
      await this.saveSettings();
      return;
    }
    const content = await this.app.vault.read(file);
    const lines = content.split("\n").map((l) => l.trimEnd());
    const headerIndex = lines.findIndex(isHeaderRow);
    if (headerIndex === -1) {
      this.settings.logFormatVersion = 2;
      await this.saveSettings();
      return;
    }
    const bodyLines = lines.slice(headerIndex + 2);
    let rows = [];
    for (const line of bodyLines) {
      if (!line.startsWith("|")) continue;
      const parts = line.split("|").map((p) => p.trim());
      rows.push(repairRow(parts));
    }
    if (rows.length > 0) {
      rows = dedupeRows(rows);
      rows = sortRows(rows, this.settings.sortMode, this.settings.sortAscending);
      const out = [
        "| Track | Artist(s) | Times played | Time listened (m:s) | Tags |",
        "|-------|-----------|--------------|---------------------|------|",
        ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} |`),
      ];
      await this.app.vault.modify(file, out.join("\n"));
      new Notice("Spotify playback: migrated listening log to 5-column format.");
    }
    this.settings.logFormatVersion = 2;
    await this.saveSettings();
  }

  async resortLogFile() {
    const filePath = this.settings.logFile || "Spotify listening log.md";
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.read(file);
    const lines = content.split("\n").map((l) => l.trimEnd());
    const headerIndex = lines.findIndex(isHeaderRow);
    if (headerIndex === -1) return;
    const bodyLines = lines.slice(headerIndex + 2);
    let rows = [];
    for (const line of bodyLines) {
      if (!line.startsWith("|")) continue;
      const parts = line.split("|").map((p) => p.trim());
      rows.push(repairRow(parts));
    }
    rows = dedupeRows(rows);
    rows = sortRows(rows, this.settings.sortMode, this.settings.sortAscending);
    const out = [
      "| Track | Artist(s) | Times played | Time listened (m:s) | Tags |",
      "|-------|-----------|--------------|---------------------|------|",
      ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} |`),
    ];
    await this.app.vault.modify(file, out.join("\n"));
  }

  notifySettingChange() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SPOTIFY)) {
      const v = leaf.view;
      if (v?.lastData && v.updateNowPlaying) v.updateNowPlaying(v.lastData);
    }
  }
};

/* -------------------------- Spotify View -------------------------- */

class SpotifyView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.lastData = null;
    this.progressTimer = null;
  }

  getViewType() { return VIEW_TYPE_SPOTIFY; }
  getDisplayText() { return "Spotify player"; }

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
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  async updateNowPlaying(data) {
    this.lastData = data;
    this.contentEl.empty();

    const track = data.item;
    if (!track) { this.showMessage("Nothing is playing."); return; }

    if (this.plugin.settings.showAlbumArt && track.album?.images?.length) {
      const img = this.contentEl.createEl("img", { attr: { src: track.album.images[0].url } });
      img.style.maxWidth = "100%";
      img.style.borderRadius = "8px";
      img.style.marginBottom = "8px";
      img.style.boxShadow = "0 2px 8px rgba(0,0,0,0.25)";
    }

    const trackTitleEl = this.contentEl.createDiv({
      cls: "spotify-track-title",
      text: track.name || "Unknown track",
    });


    this.contentEl.createDiv({
      cls: "spotify-track-artist",
      text: (track.artists || []).map((a) => a.name).join(", "),
    });


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

    if (this.plugin.settings.showControls) {
      const controls = this.contentEl.createDiv({ cls: "spotify-controls" });

      if (this.plugin.settings.showPrevNext) {
        const prevBtn = controls.createEl("button", { text: "⏮" });
        prevBtn.onclick = async () => {
          await this.plugin.spotifyApiCall("POST", "me/player/previous");
          this.plugin.syncNowPlaying();
        };
      }

      const playPauseBtn = controls.createEl("button", { text: data.is_playing ? "⏸" : "▶" });
      playPauseBtn.onclick = async () => {
        await this.plugin.spotifyApiCall("PUT", `me/player/${data.is_playing ? "pause" : "play"}`);
        this.plugin.syncNowPlaying();
      };

      if (this.plugin.settings.showPrevNext) {
        const nextBtn = controls.createEl("button", { text: "⏭" });
        nextBtn.onclick = async () => {
          await this.plugin.spotifyApiCall("POST", "me/player/next");
          this.plugin.syncNowPlaying();
        };
      }

      if (this.plugin.settings.showShuffle) {
        const shuffleBtn = controls.createEl("button", { text: data.shuffle_state ? "🔀 On" : "🔀 Off" });
        shuffleBtn.onclick = async () => {
          await this.plugin.spotifyApiCall("PUT", `me/player/shuffle?state=${!data.shuffle_state}`);
          this.plugin.syncNowPlaying();
        };
      }

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

/* -------------------------- Settings Tab -------------------------- */

class SpotifySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Spotify playback").setHeading();

    new Setting(containerEl)
      .setName("Client id")
      .setDesc("Enter your Spotify app client id.")
      .addText((t) =>
         t.setPlaceholder("Enter client id")
         .setValue(this.plugin.settings.clientId ? "********" : "")
         .onChange(async (val) => {
           if (val && val !== "********") {
             this.plugin.settings.clientId = val.trim();
             await this.plugin.saveSettings();
           }
         })
      );

    new Setting(containerEl)
      .setName("Client secret")
      .setDesc("Enter your Spotify app client secret.")
      .addText((t) =>
        t.setPlaceholder("Enter client secret")
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
      .setName("Listening log")
      .setDesc("Accumulates listening time; <5s sessions ignored. Times played increments when ≥90% or track finishes.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.logListening).onChange(async (val) => {
          this.plugin.settings.logListening = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Listening log file")
      .setDesc("Markdown file that stores the listening log table.")
      .addText((text) =>
        text.setPlaceholder("Spotify listening log.md")
            .setValue(this.plugin.settings.logFile)
            .onChange(async (val) => {
              this.plugin.settings.logFile = val.trim();
              await this.plugin.saveSettings();
            })
      );

    new Setting(containerEl).setName("Display options").setHeading();

    new Setting(containerEl).setName("Show album art").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showAlbumArt).onChange(async (val) => {
        this.plugin.settings.showAlbumArt = val;
        await this.plugin.saveSettings();
        this.plugin.notifySettingChange();
      })
    );

    new Setting(containerEl).setName("Show track time").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showTrackTime).onChange(async (val) => {
        this.plugin.settings.showTrackTime = val;
        await this.plugin.saveSettings();
        this.plugin.notifySettingChange();
      })
    );

    new Setting(containerEl).setName("Show controls").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showControls).onChange(async (val) => {
        this.plugin.settings.showControls = val;
        await this.plugin.saveSettings();
        this.plugin.notifySettingChange();
      })
    );

    new Setting(containerEl).setName("Show shuffle button").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showShuffle).onChange(async (val) => {
        this.plugin.settings.showShuffle = val;
        await this.plugin.saveSettings();
        this.plugin.notifySettingChange();
      })
    );

    new Setting(containerEl).setName("Show repeat button").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showRepeat).onChange(async (val) => {
        this.plugin.settings.showRepeat = val;
        await this.plugin.saveSettings();
        this.plugin.notifySettingChange();
      })
    );

    new Setting(containerEl).setName("Show previous/next buttons").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showPrevNext).onChange(async (val) => {
        this.plugin.settings.showPrevNext = val;
        await this.plugin.saveSettings();
        this.plugin.notifySettingChange();
      })
    );

    new Setting(containerEl).setName("Sorting options").setHeading();

    new Setting(containerEl)
      .setName("Sort log by")
      .setDesc("Choose how the listening log table is sorted.")
      .addDropdown((dd) => {
        dd.addOption("insertion", "Insertion order");
        dd.addOption("time", "Time listened");
        dd.addOption("plays", "Times played");
        dd.setValue(this.plugin.settings.sortMode || "insertion");
        dd.onChange(async (val) => {
          this.plugin.settings.sortMode = val;
          await this.plugin.saveSettings();
          await this.plugin.resortLogFile();
        });
      });

    new Setting(containerEl)
      .setName("Ascending order")
      .setDesc("If enabled, sort order will be ascending instead of descending.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.sortAscending).onChange(async (val) => {
          this.plugin.settings.sortAscending = val;
          await this.plugin.saveSettings();
          await this.plugin.resortLogFile();
        })
      );
  }
}
