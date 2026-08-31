# Development diagnostics

These utilities support Fitia protocol discovery and local iOS diagnostics. They are not part of the shipped `fitia` or `fitia-mcp` products and do not appear in their command contracts.

## Device inspection

Requires macOS, Xcode, and a connected, unlocked, paired iPhone.

```sh
bun run dev:device list
bun run dev:device inspect --device <returned-id>
```

The inspector checks only `com.ulisesolave.Fitia`, lists at most the root of its app data container, and copies no app data. A failed listing does not prove that local data is absent.

## HAR inspection

Raw captures can contain credentials, health information, and account data. Keep them outside the repository.

```sh
bun run dev:capture --file /absolute/path/to/fitia.har
bun run dev:capture --file /absolute/path/to/fitia.har --host firestore.googleapis.com
```

The summary omits request headers, cookies, and all query and body values. It generalizes likely identifiers in paths and never replays a request. Route and field names can still reveal context, so review output before sharing it.

Keep captures and disposable certificate material outside the repository with restrictive permissions. Obtain explicit authorization before changing device network or trust settings, stop when certificate validation fails, and never bypass pinning or expand a capture to unrelated hosts.

See [the food search evidence](../docs/food-search-evidence.md) for the durable protocol facts extracted from the completed capture. Discovery timelines and temporary setup logs are intentionally not retained.
