## OCT Desktop

### macOS first launch

OCT isn't signed with an Apple Developer certificate yet, so macOS will block it on first launch ("OCT is damaged" or "from an unidentified developer"). This is expected — clear it once:

1. Drag **OCT.app** into your Applications folder.
2. Open **Terminal** (Applications → Utilities → Terminal).
3. Run:

   ```bash
   xattr -cr /Applications/OCT.app
   ```

4. Press Enter, then open OCT. Enjoy!
