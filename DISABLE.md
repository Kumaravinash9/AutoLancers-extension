# Turning the collector off

Three levels, weakest to strongest. Use the strongest one you can while diagnosing anything wrong
with your Upwork account or browser — a toggle you have to trust is weaker evidence than a
capability the browser will not grant.

## 1. Nothing runs automatically  *(already true)*

There is no automatic trigger. A collection starts only when you press **Collect** — no schedule, no
alarm, no listener on navigation.

## 2. Slow it down

Settings → **Read `1` page at a time**. One page, then a 4–9 second pause, then the next. About 76
seconds for eight pages instead of 4, and far less like a script.

## 3. Remove the extension's access to Upwork entirely

Edit `manifest.json` and delete `"https://www.upwork.com/*"` from `host_permissions`, then reload
the extension at `chrome://extensions`.

The collector then cannot open or read any Upwork page — not because it agrees not to, but because
Chrome will refuse. The single-page reader still works on a tab you have open, since that runs on
`activeTab`, which is granted by your click rather than by the manifest.

To go further still, toggle the extension off at `chrome://extensions`, or remove it.

## Which one to use

If something is wrong with your account or your browser and you are trying to find out whether this
extension is the cause, use **3**. Levels 1 and 2 leave the capability in place, so a run you did
not expect is still possible, and that is exactly the uncertainty you are trying to remove.
