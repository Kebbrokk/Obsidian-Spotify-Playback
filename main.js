const { Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, requestUrl, Notice } = require("obsidian");
const http = require("http");

const VIEW_TYPE_SPOTIFY = "spotify-playback-view";

module.exports = class SpotifyPlaybackHelper extends Plugin {
  async onload() {
    console.log("Spotify Playback Helper loaded");

    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_SPOTIFY,
      (leaf) => new SpotifyView(leaf, this)
    );

    this.addRibbonIcon("music", "Spotify Playback", () => {
      this.activateView();
    });

    this.addSettingTab(new SpotifySettingTab(this.app, this));

    // Auto-refresh every 50 min
    this.registerInterval(window.setInterval(() => {
      if (this.settings.refreshToken) {
        this.refreshAccessToken();
      }
    }, 50 * 60 * 1000));
  }

  onunload() {
    console.log("Spotify Playback Helper unloaded");
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
    const scopes = "user-read-playback-state user-modify-playback-state user-read-currently-playing";
    const authUrl = `https://accounts.spotify.com/authorize?client_id=${this.settings.clientId}&response_type=code&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&scope=${encodeURIComponent(scopes)}`;

    window.open(authUrl);
    new Notice("Opened Spotify login in browser...");

    // Local server to catch the redirect
    const server = http.createServer(async (req, res) => {
      if (req.url.startsWith("/callback")) {
        const params = new URL("http://127.0.0.1:8888" + req.url).searchParams;
        const code = params.get("code");

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h2>Spotify Login successful! You can close this tab.</h2>");
        server.close();

        // Exchange code for tokens
        try {
          const tokenRes = await requestUrl({
            url: "https://accounts.spotify.com/api/token",
            method: "POST",
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectUri,
              client_id: this.settings.clientId,
              client_secret: this.settings.clientSecret,
            }).toString(),
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          });

          const data = tokenRes.json;
          this.settings.accessToken = data.access_token;
          this.settings.refreshToken = data.refresh_token;
          await this.saveSettings();
          new Notice("Spotify login successful!");
        } catch (err) {
          console.error("Auth failed:", err);
          new Notice("Spotify auth failed (check console).");
        }
      }
    });
    server.listen(8888);
  }

  async refreshAccessToken() {
    if (!this.settings.refreshToken) return;
    try {
      const res = await requestUrl({
        url: "https://accounts.spotify.com/api/token",
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: this.settings.refreshToken,
          client_id: this.settings.clientId,
          client_secret: this.settings.clientSecret,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      const data = res.json;
      this.settings.accessToken = data.access_token;
      await this.saveSettings();
      console.log("Spotify token refreshed");
    } catch (err) {
      console.error("Failed to refresh token", err);
    }
  }
};

/* ---------------- VIEW ---------------- */

class SpotifyView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
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
    const container = this.containerEl.children[1];
    container.empty();

    this.albumEl = container.createEl("img", { cls: "spotify-album-art" });
    this.trackEl = container.createEl("div", { text: "Track: -" });
    this.artistEl = container.createEl("div", { text: "Artist: -" });
    this.timeEl = container.createEl("div", { text: "0:00 / 0:00" });

    // Controls
    this.controlsEl = container.createDiv("spotify-controls");
    this.playBtn = this.controlsEl.createEl("button", { text: "▶️" });
    this.prevBtn = this.controlsEl.createEl("button", { text: "⏮️" });
    this.nextBtn = this.controlsEl.createEl("button", { text: "⏭️" });
    this.shuffleBtn = this.controlsEl.createEl("button", { text: "🔀" });
    this.repeatBtn = this.controlsEl.createEl("button", { text: "🔁" });

    this.playBtn.addEventListener("click", () => this.togglePlay());
    this.prevBtn.addEventListener("click", () => this.apiCall("previous"));
    this.nextBtn.addEventListener("click", () => this.apiCall("next"));
    this.shuffleBtn.addEventListener("click", () =>
      this.setShuffle(!this.currentShuffle)
    );
    this.repeatBtn.addEventListener("click", () =>
      this.setRepeat(this.currentRepeat === "off" ? "context" : "off")
    );

    this.refreshInterval = setInterval(() => this.refresh(), 1000);
  }

  async onClose() {
    clearInterval(this.refreshInterval);
  }

  async refresh() {
    if (!this.plugin.settings.accessToken) return;

    try {
      const res = await requestUrl({
        url: "https://api.spotify.com/v1/me/player",
        headers: { Authorization: `Bearer ${this.plugin.settings.accessToken}` },
      });

      if (res.status === 204) {
        this.trackEl.setText("Track: -");
        this.artistEl.setText("Artist: -");
        this.timeEl.setText("0:00 / 0:00");
        this.albumEl.src = "";
        this.isPlaying = false;
        this.updateButtonStates();
        return;
      }

      const data = res.json;
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

        this.currentShuffle = data.shuffle_state;
        this.currentRepeat = data.repeat_state;
        this.isPlaying = data.is_playing;
        this.updateButtonStates();
      }
    } catch (err) {
      console.error("Spotify refresh error:", err);
    }
  }

  updateButtonStates() {
    this.playBtn.setText(this.isPlaying ? "⏸️" : "▶️");
    this.shuffleBtn.setText(this.currentShuffle ? "🔀✅" : "🔀");
    this.repeatBtn.setText(
      this.currentRepeat === "off"
        ? "🔁"
        : this.currentRepeat === "track"
        ? "🔂"
        : "🔁✅"
    );
  }

  async togglePlay() {
    if (this.isPlaying) {
      await this.apiCall("pause");
    } else {
      await this.apiCall("play");
    }
  }

  async apiCall(action) {
    let endpoint = "";
    if (action === "next") endpoint = "next";
    if (action === "previous") endpoint = "previous";
    if (action === "play") endpoint = "play";
    if (action === "pause") endpoint = "pause";

    try {
      await requestUrl({
        url: `https://api.spotify.com/v1/me/player/${endpoint}`,
        method: "POST",
        headers: { Authorization: `Bearer ${this.plugin.settings.accessToken}` },
      });
    } catch (err) {
      console.error("Spotify API call failed:", err);
    }
  }

  async setShuffle(state) {
    try {
      await requestUrl({
        url: `https://api.spotify.com/v1/me/player/shuffle?state=${state}`,
        method: "PUT",
        headers: { Authorization: `Bearer ${this.plugin.settings.accessToken}` },
      });
      this.currentShuffle = state;
      this.updateButtonStates();
    } catch (err) {
      console.error("Failed to set shuffle:", err);
    }
  }

  async setRepeat(mode) {
    try {
      await requestUrl({
        url: `https://api.spotify.com/v1/me/player/repeat?state=${mode}`,
        method: "PUT",
        headers: { Authorization: `Bearer ${this.plugin.settings.accessToken}` },
      });
      this.currentRepeat = mode;
      this.updateButtonStates();
    } catch (err) {
      console.error("Failed to set repeat:", err);
    }
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

    new Setting(containerEl)
      .setName("Client ID")
      .setDesc("Spotify App Client ID")
      .addText((text) =>
        text.setValue(this.plugin.settings.clientId).onChange(async (value) => {
          this.plugin.settings.clientId = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Client Secret")
      .setDesc("Spotify App Client Secret")
      .addText((text) =>
        text.setValue(this.plugin.settings.clientSecret).onChange(async (value) => {
          this.plugin.settings.clientSecret = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Login with Spotify")
      .setDesc("Authenticate with Spotify")
      .addButton((btn) =>
        btn.setButtonText("Login").onClick(async () => {
          await this.plugin.beginAuth();
        })
      );

    containerEl.createEl("h3", { text: "Display Options" });

    new Setting(containerEl)
      .setName("Show Album Art")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showAlbumArt).onChange(async (value) => {
          this.plugin.settings.showAlbumArt = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show Track Time")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showTrackTime).onChange(async (value) => {
          this.plugin.settings.showTrackTime = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show Controls")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showControls).onChange(async (value) => {
          this.plugin.settings.showControls = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
