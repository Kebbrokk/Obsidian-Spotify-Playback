# Obsidian-Spotify-Playback
Allow for Spotify to be played back through Obsidian. 

**This Plugin requires a Spotify Premium and Developer account**

Spotify Playback Features
   - Album Art
   - Track Name and Artist
   - Player Controls [Play / Pause], [Prev],[Next]

Future Features
- Track Time
- Toggled settings: Album Art, Track Time
- Different Themes for Dark / Light. 

## Instructions
    Create a Spotify Developer Account [[https://developer.spotify.com/dashboard]]
     - Create App
     Follow steps to fill in your basic Information. 
      - Set your Redirect URI to obsidian://spotify/auth
      - API's Used
        - Web API
        - Web Playback SDK
    You will need the Client ID and Client Secret when trying to connect your Spotify to Obsidian.

# Open your plugins folder
- Drag and drop the plugin into your plugins folder.
- Enable it in the Community Plugins Settings
- Copy over your Client ID and Client Secret [Remember to keep these hidden]
    - The plugin masks the string of digits for some privacy.

Open your terminal and search for Spotify Playback Helper: Login to Spotify
- This will open up your browser and ask for permission to sync to Spotify
- Choose Obsidian as your application to open. [You do not need to click the Always Use option.]
- Once connected open your terminal and search for Spotify Playback Helper: Open Now Playing Sidebar.
- This will allow for the plugin to be placed on either sidebar for viewing.
- You can also use hotkeys and terminal commands to play spotify tracks.

__ If you are playing something spotify it will show up. If not open spotify and select a playlist or album. 