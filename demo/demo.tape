# Records the launch clip: vhs demo/demo.tape (from the repo root)
Output ../sheetstream-launch/demo.gif
Output ../sheetstream-launch/demo.mp4
Set Shell "bash"
Set FontFamily "JetBrains Mono,Menlo,monospace"
Set FontSize 17
Set Width 1400
Set Height 370
Set Padding 26
Set TypingSpeed 40ms
Set Framerate 30
Set Theme { "name": "sheetstream", "black": "#0a0a0a", "red": "#e5594f", "green": "#7fb77e", "yellow": "#c97a4e", "blue": "#7d9ec0", "magenta": "#b08ab5", "cyan": "#6fb3b0", "white": "#d9d4cc", "brightBlack": "#6f6a63", "brightRed": "#f0766b", "brightGreen": "#98cc96", "brightYellow": "#e09468", "brightBlue": "#9bb8d6", "brightMagenta": "#c6a3cb", "brightCyan": "#8ccbc8", "brightWhite": "#f2eee8", "background": "#0a0a0a", "foreground": "#d9d4cc", "selection": "#2a2420", "cursor": "#c97a4e" }
Hide
Type "export PS1='$ '"
Enter
Type "clear"
Enter
Type "node --max-old-space-size=1024 demo/demo.mjs"
Show
Sleep 800ms
Enter
Sleep 11s
Sleep 3s
