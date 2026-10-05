Test fixtures (generated with ffmpeg):

- `movie-a.webm`: 60 s test pattern, VP8, **no audio track**
- `movie-b.webm`: 50 s colour bars, VP8, no audio (a "different file" for mismatch tests)
- `subs.srt`: two subtitle cues

Why no audio: Playwright's Linux WebKit (used for the iPhone/iPad projects) has no audio
output, and a file with sound makes its playback clock jump to the end. Real devices are fine.
Why not MP4: Playwright's Chromium and WebKit builds don't include the H.264 codec.

Regenerate:
    ffmpeg -f lavfi -i "testsrc2=size=640x360:rate=25:duration=60" -c:v libvpx -b:v 250k -an movie-a.webm
    ffmpeg -f lavfi -i "smptebars=size=640x360:rate=25:duration=50" -c:v libvpx -b:v 150k -an movie-b.webm
