const { Plugin, PluginSettingTab, Setting, Notice, ItemView } = require("obsidian");

const SPOTIFY_SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
].join(" ");

const NOW_PLAYING_VIEW_TYPE = "spotify-now-playing-view";

class SpotifyPlaybackPlugin extends Plugin {
  async onload() {
    console.log("Spotify Playback loaded!");

    await this.loadSettings();

    // Settings tab
    this.addSettingTab(new SpotifySettingsTab(this.app, this));

    // Login command
    this.addCommand({
      id: "spotify-login",
      name: "Login to Spotify",
      callback: () => this.beginAuth(),
    });

    // Register live Now Playing view
    this.registerView(
      NOW_PLAYING_VIEW_TYPE,
      (leaf) => new SpotifyNowPlayingView(leaf, this)
    );

    // Command to open sidebar panel
    this.addCommand({
      id: "spotify-open-now-playing",
      name: "Open Spotify Now Playing Panel",
      callback: async () => {
        this.activateNowPlayingView();
      },
    });

    // Protocol handler for OAuth
    this.registerObsidianProtocolHandler("spotify/auth", (params) => {
      const code = params.code;
      if (!code) {
        new Notice("No authorization code received from Spotify.");
        return;
      }
      this.exchangeCodeForToken(code);
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(NOW_PLAYING_VIEW_TYPE);
    new Notice("Spotify Playback unloaded!");
  }

  async activateNowPlayingView() {
    let leaf = this.app.workspace.getLeavesOfType(NOW_PLAYING_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: NOW_PLAYING_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign(
      { clientId: "", clientSecret: "", accessToken: "", refreshToken: "" },
      await this.loadData()
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async beginAuth() {
    if (!this.settings.clientId) {
      new Notice("Set your Spotify Client ID in plugin settings.");
      return;
    }

    const authUrl =
      `https://accounts.spotify.com/authorize` +
      `?client_id=${encodeURIComponent(this.settings.clientId)}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent("obsidian://spotify/auth")}` +
      `&scope=${encodeURIComponent(SPOTIFY_SCOPES)}`;

    new Notice("Opening Spotify login in browser...");
    window.open(authUrl, "_blank");
  }

  async exchangeCodeForToken(code) {
    const { clientId, clientSecret } = this.settings;

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "obsidian://spotify/auth",
      client_id: clientId,
      client_secret: clientSecret,
    });

    try {
      const resp = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      const data = await resp.json();

      if (data.access_token) {
        this.settings.accessToken = data.access_token;
        this.settings.refreshToken = data.refresh_token;
        await this.saveSettings();
        new Notice("Spotify login successful!");
      } else {
        console.error(data);
        new Notice("Failed to get access token from Spotify.");
      }
    } catch (err) {
      console.error(err);
      new Notice("Error exchanging code for token.");
    }
  }

  async refreshToken() {
    const { clientId, clientSecret, refreshToken } = this.settings;
    if (!refreshToken) return;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    const resp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + btoa(clientId + ":" + clientSecret),
      },
      body,
    });

    const data = await resp.json();
    if (data.access_token) {
      this.settings.accessToken = data.access_token;
      await this.saveSettings();
    }
  }

  async spotifyApiCall(method, endpoint) {
    if (!this.settings.accessToken) {
      new Notice("No access token. Please log in first.");
      return;
    }

    let resp = await fetch(`https://api.spotify.com/v1/${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${this.settings.accessToken}` },
    });

    if (resp.status === 401) {
      await this.refreshToken();
      resp = await fetch(`https://api.spotify.com/v1/${endpoint}`, {
        method,
        headers: { Authorization: `Bearer ${this.settings.accessToken}` },
      });
    }

    if (!resp.ok) {
      console.error("Spotify API error:", resp.status, await resp.text());
    }

    return resp.ok ? await resp.json().catch(() => null) : null;
  }
}

// Settings Tab
// Settings Tab
class SpotifySettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Spotify Playback Settings" });

    new Setting(containerEl)
      .setName("Client ID")
      .setDesc("Your Spotify App Client ID")
      .addText((text) =>
        text
          .inputEl.setAttribute("type", "password"), // 🔒 mask input
        text
          .setPlaceholder("Enter Spotify Client ID")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Client Secret")
      .setDesc("Your Spotify App Client Secret")
      .addText((text) =>
        text
          .inputEl.setAttribute("type", "password"), // 🔒 mask input
        text
          .setPlaceholder("Enter Spotify Client Secret")
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value;
            await this.plugin.saveSettings();
          })
      );
  }
}


// Now Playing View with buttons
class SpotifyNowPlayingView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.containerEl.addClass("spotify-now-playing-container");
    this.updateInterval = null;
  }

  getViewType() {
    return NOW_PLAYING_VIEW_TYPE;
  }

  getDisplayText() {
    return "Spotify Now Playing";
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "Loading Spotify Now Playing..." });

    // Update every 5 seconds
    this.updateInterval = setInterval(() => this.updateView(), 5000);
    this.updateView();
  }

  async onClose() {
    if (this.updateInterval) clearInterval(this.updateInterval);
  }

  async updateView() {
    const np = await this.plugin.spotifyApiCall(
      "GET",
      "me/player/currently-playing"
    );

    this.contentEl.empty();

    if (!np || !np.item) {
      this.contentEl.createEl("p", { text: "Nothing is playing right now." });
      return;
    }

    const track = np.item.name ?? "Unknown";
    const artist = np.item.artists?.map((a) => a.name).join(", ") ?? "Unknown Artist";
    const albumArt = np.item.album?.images?.[0]?.url ?? "";

    if (albumArt) {
      const img = this.contentEl.createEl("img");
      img.src = albumArt;
      img.style.width = "100%";
      img.style.borderRadius = "5px";
      img.style.marginBottom = "8px";
    }

    this.contentEl.createEl("strong", { text: track });
    this.contentEl.createEl("p", { text: artist });

    // Create control buttons
    const controls = this.contentEl.createEl("div");
    controls.style.display = "flex";
    controls.style.justifyContent = "space-around";
    controls.style.marginTop = "8px";

    const playPauseBtn = controls.createEl("button", { text: "Play/Pause" });
    playPauseBtn.onclick = async () => {
      const status = np.is_playing;
      await this.plugin.spotifyApiCall(
        "PUT",
        status ? "me/player/pause" : "me/player/play"
      );
      this.updateView();
    };

    const prevBtn = controls.createEl("button", { text: "Prev" });
    prevBtn.onclick = async () => {
      await this.plugin.spotifyApiCall("POST", "me/player/previous");
      this.updateView();
    };

    const nextBtn = controls.createEl("button", { text: "Next" });
    nextBtn.onclick = async () => {
      await this.plugin.spotifyApiCall("POST", "me/player/next");
      this.updateView();
    };
  }
}

module.exports = {
  default: SpotifyPlaybackPlugin,
};
