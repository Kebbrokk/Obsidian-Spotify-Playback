const { Plugin, PluginSettingTab, Setting, ItemView, Notice } = require("obsidian");
const http = require("http");
const { Buffer } = require("buffer");

const VIEW_TYPE_SPOTIFY = "spotify-playback-view";

module.exports = class SpotifyPlaybackHelper extends Plugin {
  async onload() {
    console.log("Spotify Playback Helper loaded");
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_SPOTIFY,
      (leaf) => new SpotifyView(leaf, this)
    );

    this.addRibbonIcon("music", "Spotify Playback", () => this.activateView());
    this.addSettingTab(new SpotifySettingTab(this.app, this));

    if (this.settings.refreshToken) await this.refreshAccessToken();

    this.registerInterval(
      window.setInterval(() => this.refreshAccessToken(), 50 * 60 * 1000)
    );
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SPOTIFY);
  }

  async activateView() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SPOTIFY);
    await this.app.workspace.getRightLeaf(false).setViewState({
      type: VIEW_TYPE_SPOTIFY,
      active: true,
    });
  }

  async loadSettings() {
    this.settings = Object.assign(
      {
        clientId: "",
        clientSecret: "",
        accessToken: "",
        refreshToken: "",
        showAlbumArt: true,
        showTrackTime: true,
        showControls: true,
      },
      await this.loadData()
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async beginAuth() {
    if (!this.settings.clientId || !this.settings.clientSecret) {
      new Notice("Please set Client ID and Secret first.");
      return;
    }

    const redirectUri = "http://127.0.0.1:8888/callback";
    const scopes =
      "user-read-playback-state user-modify-playback-state user-read-currently-playing";
    const authUrl = `https://accounts.spotify.com/authorize?client_id=${
      this.settings.clientId
    }&response_type=code&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&scope=${encodeURIComponent(scopes)}`;

    const server = http.createServer(async (req, res) => {
      if (req.url.startsWith("/callback")) {
        const url = new URL(req.url, "http://127.0.0.1:8888");
        const code = url.searchParams.get("code");
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Spotify login successful! You can close this tab.");
        server.close();

        await this.exchangeCodeForToken(code, redirectUri);
        new Notice("Spotify login complete!");

        this.app.workspace.getLeavesOfType(VIEW_TYPE_SPOTIFY).forEach((leaf) => {
          if (leaf.view.refreshNowPlaying) leaf.view.refreshNowPlaying();
        });
      }
    });
    server.listen(8888);

    window.open(authUrl);
    new Notice("Opened Spotify login in browser.");
  }

  async exchangeCodeForToken(code, redirectUri) {
    const creds = Buffer.from(
      `${this.settings.clientId}:${this.settings.clientSecret}`
    ).toString("base64");

    try {
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${creds}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      });
      const data = await res.json();
      if (data.access_token) {
        this.settings.accessToken = data.access_token;
        this.settings.refreshToken = data.refresh_token;
        await this.saveSettings();
      } else {
        console.error("Token exchange failed:", data);
        new Notice("Failed to exchange Spotify token. Check console.");
      }
    } catch (err) {
      console.error("Spotify exchange error:", err);
      new Notice("Failed to exchange Spotify token. Check console.");
    }
  }

  async refreshAccessToken() {
    if (!this.settings.refreshToken) return false;

    const creds = Buffer.from(
      `${this.settings.clientId}:${this.settings.clientSecret}`
    ).toString("base64");

    try {
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${creds}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: this.settings.refreshToken,
        }),
      });
      const data = await res.json();
      if (data.access_token) {
        this.settings.accessToken = data.access_token;
        await this.saveSettings();
        return true;
      }
      return false;
    } catch (err) {
      console.error("Spotify token refresh error", err);
      return false;
    }
  }

  async spotifyApiCall(method, endpoint, body) {
    if (!this.settings.accessToken) {
      const refreshed = await this.refreshAccessToken();
      if (!refreshed) {
        new Notice("Spotify token missing. Please login.");
        return null;
      }
    }
    try {
      const res = await fetch(`https://api.spotify.com/v1/${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.settings.accessToken}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.ok ? await res.json() : null;
    } catch (err) {
      console.error("Spotify API call failed", err);
      return null;
    }
  }
};

/* ---------------- VIEW ---------------- */

class SpotifyView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.interval = null;
    this.currentShuffle = false;
    this.currentRepeat = "off";
    this.isPlaying = false;
  }

  getViewType() {
    return VIEW_TYPE_SPOTIFY;
  }

  getDisplayText() {
    return "Spotify Playback";
  }

async onOpen() {
    this.container = this.containerEl.children[1];
    this.container.empty();

    this.container.createEl("h3", { text: "Now Playing" });

    if (this.plugin.settings.showAlbumArt) {
      this.albumEl = this.container.createEl("img", {
        attr: { src: "", style: "max-width:100%; border-radius:8px;" },
      });
    }

    this.trackEl = this.container.createEl("div", { text: "Track: -" });
    this.artistEl = this.container.createEl("div", { text: "Artist: -" });

    if (this.plugin.settings.showTrackTime) {
      this.timeEl = this.container.createEl("div", { text: "0:00 / 0:00" });
    }

    this.controlsEl = this.container.createEl("div", { cls: "spotify-controls" });

    // Prev / Play / Next
    if (this.plugin.settings.showPrevNext) {
      this.prevBtn = this.controlsEl.createEl("button", { text: "⏮️" });
      this.prevBtn.onclick = () =>
        this.plugin.spotifyApiCall("POST", "me/player/previous");

      this.playPauseBtn = this.controlsEl.createEl("button", { text: "▶️" });
      this.playPauseBtn.onclick = async () => {
        if (this.isPlaying) {
          await this.plugin.spotifyApiCall("PUT", "me/player/pause");
          this.isPlaying = false;
        } else {
          await this.plugin.spotifyApiCall("PUT", "me/player/play");
          this.isPlaying = true;
        }
        this.updateButtonStates();
      };

      this.nextBtn = this.controlsEl.createEl("button", { text: "⏭️" });
      this.nextBtn.onclick = () =>
        this.plugin.spotifyApiCall("POST", "me/player/next");
    }

    // Shuffle / Repeat
    if (this.plugin.settings.showShuffle) {
      this.shuffleBtn = this.controlsEl.createEl("button", { text: "🔀" });
      this.shuffleBtn.onclick = async () => {
        const state = !this.currentShuffle;
        await this.plugin.spotifyApiCall(
          "PUT",
          `me/player/shuffle?state=${state}`
        );
        this.currentShuffle = state;
        this.updateButtonStates();
      };
    }

    if (this.plugin.settings.showRepeat) {
      this.repeatBtn = this.controlsEl.createEl("button", { text: "🔁" });
      this.repeatBtn.onclick = async () => {
        const nextState =
          this.currentRepeat === "off"
            ? "context"
            : this.currentRepeat === "context"
            ? "track"
            : "off";
        await this.plugin.spotifyApiCall(
          "PUT",
          `me/player/repeat?state=${nextState}`
        );
        this.currentRepeat = nextState;
        this.updateButtonStates();
      };
    }

    // Refresh loop
    this.refreshInterval = setInterval(async () => {
      const data = await this.plugin.spotifyApiCall("GET", "me/player");
      if (data && data.item) {
        this.trackEl.setText("Track: " + data.item.name);
        this.artistEl.setText(
          "Artist: " + data.item.artists.map((a) => a.name).join(", ")
        );

        if (this.plugin.settings.showAlbumArt && data.item.album.images[0]) {
          this.albumEl.src = data.item.album.images[0].url;
        }

        if (this.plugin.settings.showTrackTime) {
          const progress = Math.floor(data.progress_ms / 1000);
          const duration = Math.floor(data.item.duration_ms / 1000);
          this.timeEl.setText(
            `${this.formatTime(progress)} / ${this.formatTime(duration)}`
          );
        }

        // Sync shuffle / repeat / play state
        this.currentShuffle = data.shuffle_state;
        this.currentRepeat = data.repeat_state;
        this.isPlaying = data.is_playing;
        this.updateButtonStates();
      }
    }, 1000);
  }

  updateButtonStates() {
    if (this.shuffleBtn) {
      this.shuffleBtn.style.opacity = this.currentShuffle ? "1" : "0.4";
    }
    if (this.repeatBtn) {
      this.repeatBtn.style.opacity = this.currentRepeat !== "off" ? "1" : "0.4";
      this.repeatBtn.textContent =
        this.currentRepeat === "track" ? "🔂" : "🔁";
    }
    if (this.playPauseBtn) {
      this.playPauseBtn.textContent = this.isPlaying ? "⏸️" : "▶️";
    }
  }

  formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  async onClose() {
    if (this.interval) clearInterval(this.interval);
  }

  async refreshNowPlaying() {
    const data = await this.plugin.spotifyApiCall("GET", "me/player");
    if (!data || !data.item) return;

    if (this.plugin.settings.showAlbumArt && data.item.album.images[0]) {
      this.albumArt.src = data.item.album.images[0].url;
    } else {
      this.albumArt.src = "";
    }

    this.trackText.setText(`${data.item.name} — ${data.item.artists.map(a => a.name).join(", ")}`);

    if (this.plugin.settings.showTrackTime) {
      const progress = Math.floor(data.progress_ms / 1000);
      const duration = Math.floor(data.item.duration_ms / 1000);
      this.timeEl.setText(`${this.formatTime(progress)} / ${this.formatTime(duration)}`);
    } else {
      this.timeEl.setText("");
    }

    this.currentShuffle = data.shuffle_state;
    this.currentRepeat = data.repeat_state;
    this.isPlaying = data.is_playing;
    this.updateButtonStates();

    this.controls.style.display = this.plugin.settings.showControls ? "flex" : "none";
  }

  updateButtonStates() {
    this.playPauseBtn.setText(this.isPlaying ? "⏸️" : "▶️");
    this.shuffleBtn.setText(this.currentShuffle ? "🔀✅" : "🔀");
    this.repeatBtn.setText(this.currentRepeat === "off" ? "🔁" : "🔁✅");
  }

  async togglePlay() {
    if (this.isPlaying) await this.apiCall("pause");
    else await this.apiCall("play");
    await this.refreshNowPlaying();
  }

  async apiCall(action) {
    let endpoint = "";
    if (action === "next") endpoint = "next";
    if (action === "previous") endpoint = "previous";
    if (action === "play") endpoint = "play";
    if (action === "pause") endpoint = "pause";
    await this.plugin.spotifyApiCall("PUT", `me/player/${endpoint}`);
  }

  async setShuffle(state) {
    await this.plugin.spotifyApiCall("PUT", `me/player/shuffle?state=${state}`);
    this.currentShuffle = state;
    this.updateButtonStates();
  }

  async setRepeat(mode) {
    await this.plugin.spotifyApiCall("PUT", `me/player/repeat?state=${mode}`);
    this.currentRepeat = mode;
    this.updateButtonStates();
  }

  formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
}

/* ---------------- SETTINGS ---------------- */

class SpotifySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    // Masked Client ID
    new Setting(containerEl)
      .setName("Client ID")
      .setDesc("Spotify App Client ID (masked)")
      .addText((text) => {
        text.setPlaceholder("Enter Client ID");
        text.setValue(this.plugin.settings.clientId ? "*****" : "");
        text.onChange(async (v) => {
          if (v !== "*****") this.plugin.settings.clientId = v;
          await this.plugin.saveSettings();
        });
      });

    // Masked Client Secret
    new Setting(containerEl)
      .setName("Client Secret")
      .setDesc("Spotify App Client Secret (masked)")
      .addText((text) => {
        text.setPlaceholder("Enter Client Secret");
        text.setValue(this.plugin.settings.clientSecret ? "*****" : "");
        text.onChange(async (v) => {
          if (v !== "*****") this.plugin.settings.clientSecret = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Login with Spotify")
      .setDesc("Authenticate with Spotify")
      .addButton((btn) => btn.setButtonText("Login").onClick(async () => this.plugin.beginAuth()));

    containerEl.createEl("h3", { text: "Display Options" });

    // Album Art Toggle
    new Setting(containerEl)
      .setName("Show Album Art")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showAlbumArt).onChange(async (v) => {
          this.plugin.settings.showAlbumArt = v;
          await this.plugin.saveSettings();
          this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_SPOTIFY).forEach(leaf => {
            if (leaf.view.refreshNowPlaying) leaf.view.refreshNowPlaying();
          });
        })
      );

    // Track Time Toggle
    new Setting(containerEl)
      .setName("Show Track Time")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showTrackTime).onChange(async (v) => {
          this.plugin.settings.showTrackTime = v;
          await this.plugin.saveSettings();
          this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_SPOTIFY).forEach(leaf => {
            if (leaf.view.refreshNowPlaying) leaf.view.refreshNowPlaying();
          });
        })
      );

    // Controls Toggle
    new Setting(containerEl)
      .setName("Show Controls")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showControls).onChange(async (v) => {
          this.plugin.settings.showControls = v;
          await this.plugin.saveSettings();
          this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_SPOTIFY).forEach(leaf => {
            if (leaf.view.refreshNowPlaying) leaf.view.refreshNowPlaying();
          });
        })
      );
  }
}
