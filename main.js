const { Plugin, PluginSettingTab, Setting, Notice, ItemView } = require("obsidian");
const http = require("http");
const { shell } = require("electron");

const VIEW_TYPE_SPOTIFY = "spotify-now-playing";

class SpotifyPlaybackHelper extends Plugin {
  async onload() {
    console.log("Spotify Playback Helper: loading");

    await this.loadSettings();
    this.addSettingTab(new SpotifySettingsTab(this.app, this));

    this.registerView(
      VIEW_TYPE_SPOTIFY,
      (leaf) => new SpotifyNowPlayingView(leaf, this)
    );

    this.addRibbonIcon("music", "Open Spotify Now Playing", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-spotify-now-playing",
      name: "Open Spotify Now Playing",
      callback: () => this.activateView(),
    });
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SPOTIFY);
  }

  async activateView() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SPOTIFY);
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_SPOTIFY, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async refreshAccessToken() {
    if (!this.settings.refreshToken) return false;
    try {
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization":
            "Basic " +
            Buffer.from(
              this.settings.clientId + ":" + this.settings.clientSecret
            ).toString("base64"),
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
      } else {
        console.error("Failed to refresh Spotify token:", data);
        return false;
      }
    } catch (err) {
      console.error("Spotify refresh token error:", err);
      return false;
    }
  }

  async spotifyApiCall(method, endpoint, body) {
    if (!this.settings.accessToken) {
      const refreshed = await this.refreshAccessToken();
      if (!refreshed) {
        new Notice("Spotify access token missing. Please reset it.");
        return null;
      }
    }

    try {
      const res = await fetch(`https://api.spotify.com/v1/${endpoint}`, {
        method,
        headers: {
          "Authorization": `Bearer ${this.settings.accessToken}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        console.error("Spotify API error", await res.text());
        return null;
      }
      return await res.json();
    } catch (e) {
      console.error("Spotify API call failed", e);
      return null;
    }
  }

  async startAuthFlow() {
    if (!this.settings.clientId || !this.settings.clientSecret) {
      new Notice("Please set your Spotify Client ID and Secret first.");
      return;
    }

    const redirectUri = "http://127.0.0.1:8888/callback";
    const scope =
      "user-read-playback-state user-modify-playback-state user-read-currently-playing";

    const server = http.createServer(async (req, res) => {
      if (req.url.startsWith("/callback")) {
        const url = new URL(req.url, "http://127.0.0.1:8888");
        const code = url.searchParams.get("code");

        if (code) {
          try {
            const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization:
                  "Basic " +
                  Buffer.from(
                    this.settings.clientId + ":" + this.settings.clientSecret
                  ).toString("base64"),
              },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code: code,
                redirect_uri: redirectUri,
              }),
            });

            const data = await tokenRes.json();
            console.log("Token response:", data);

            if (data.access_token) {
              this.settings.accessToken = data.access_token;
              this.settings.refreshToken = data.refresh_token;
              await this.saveSettings();

              res.writeHead(200, { "Content-Type": "text/html" });
              res.end("<h1>Spotify login successful. You may now close this tab.</h1>");

              new Notice("Spotify login successful!");
            } else {
              res.writeHead(400, { "Content-Type": "text/html" });
              res.end("<h1>Spotify login failed. Check Obsidian logs.</h1>");
              new Notice("Spotify login failed.");
            }
          } catch (err) {
            console.error("Auth error:", err);
            new Notice("Spotify auth failed.");
          }
        }

        server.close();
      }
    });

    server.listen(8888, "127.0.0.1");

    const authUrl = `https://accounts.spotify.com/authorize?client_id=${encodeURIComponent(
      this.settings.clientId
    )}&response_type=code&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&scope=${encodeURIComponent(scope)}`;
    shell.openExternal(authUrl);
  }
}

const DEFAULT_SETTINGS = {
  clientId: "",
  clientSecret: "",
  accessToken: "",
  refreshToken: "",
  showAlbumArt: true,
  showTrackTime: true,
  showShuffle: true,
  showRepeat: true,
  showPrevNext: true,
  showVolume: true,
};

class SpotifySettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Spotify Playback Helper Settings" });

    new Setting(containerEl)
      .setName("Client ID")
      .setDesc("Your Spotify Developer Client ID")
      .addText((text) => {
        text.inputEl.setAttribute("type", "password");
        text.setValue(this.plugin.settings.clientId).onChange(async (value) => {
          this.plugin.settings.clientId = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Client Secret")
      .setDesc("Your Spotify Developer Client Secret")
      .addText((text) => {
        text.inputEl.setAttribute("type", "password");
        text.setValue(this.plugin.settings.clientSecret).onChange(async (value) => {
          this.plugin.settings.clientSecret = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Reset Access Token")
      .setDesc("Re-authenticate with Spotify")
      .addButton((btn) =>
        btn.setButtonText("Reset").onClick(async () => {
          this.plugin.settings.accessToken = "";
          this.plugin.settings.refreshToken = "";
          await this.plugin.saveSettings();
          this.plugin.startAuthFlow();
        })
      );

    containerEl.createEl("h3", { text: "UI Options" });

    this.addToggle(containerEl, "Show Album Art", "showAlbumArt");
    this.addToggle(containerEl, "Show Track Time", "showTrackTime");
    this.addToggle(containerEl, "Show Shuffle Button", "showShuffle");
    this.addToggle(containerEl, "Show Repeat Button", "showRepeat");
    this.addToggle(containerEl, "Show Previous/Next Buttons", "showPrevNext");
    this.addToggle(containerEl, "Show Volume Slider", "showVolume");
  }

  addToggle(containerEl, name, key) {
    new Setting(containerEl).setName(name).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
        this.plugin.settings[key] = value;
        await this.plugin.saveSettings();
      })
    );
  }
}

class SpotifyNowPlayingView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_SPOTIFY;
  }

  getDisplayText() {
    return "Spotify Now Playing";
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

    // Volume
    if (this.plugin.settings.showVolume) {
      this.volumeSlider = this.controlsEl.createEl("input", {
        type: "range",
        attr: { min: 0, max: 100, value: 50 },
      });
      this.volumeSlider.onchange = (e) =>
        this.plugin.spotifyApiCall(
          "PUT",
          `me/player/volume?volume_percent=${e.target.value}`
        );
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
    }, 3000);
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
    clearInterval(this.refreshInterval);
  }
}

module.exports = SpotifyPlaybackHelper;
