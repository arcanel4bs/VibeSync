# VibeSync
by: [Arcanel4bs](https://arcanel4bs.vercel.app/)


VibeSync is a VS Code extension that helps you manage your code state by creating filesystem snapshots as "anchor points" or "snapshots" of the directory of your choice when your code is working well. If something breaks, you can easily roll back to a previous working state.

## Features

- **Save Snapshots**: Create named, timestamped snapshots of your current workspace
- **Restore Snapshots**: Revert to any previous working state with a single click
- **Metadata & Tags**: Add descriptions and tags to organize your snapshots
- **Dedicated Sidebar**: Easily browse and manage your saved snapshots
- **Automatic Backups**: Auto-backup before restoring to prevent data loss
- **Smart Filtering**: Excludes node_modules, .git, and other large directories from snapshots

![VibeSync Sidebar](resources/sidebar-preview.png)

## Support

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Support%20the%20Project-yellow?style=for-the-badge&logo=buy-me-a-coffee)](https://buymeacoffee.com/arcanel4bs)

## Why VibeSync?

Ever got your code working perfectly, then made a small change that broke everything? VibeSync lets you:

- Create checkpoints at key development milestones
- Experiment freely with the safety of easy rollbacks
- Avoid complex Git operations for local development iterations
- Demonstrate different stages of a feature to teammates or clients

## Usage

### Creating a Snapshot

1. When your code is in a good state, use the Command Palette (`Ctrl+Shift+P`) and select **VibeSync: Save Current State**
2. Enter a name for your snapshot (e.g., "Login Feature Working")
3. (Optional) Add a description and tags
4. The snapshot will be saved in the `.vibesync` folder in your workspace

### Restoring a Snapshot

1. Open the VibeSync sidebar from the activity bar
2. Find the snapshot you want to restore
3. Click the restore icon or right-click and select "Restore"
4. Confirm the restore operation

### Managing Snapshots

- View all snapshots in the dedicated sidebar
- Delete unwanted snapshots by right-clicking and selecting "Delete"
- View snapshot details by selecting it from the command palette with **VibeSync: Show All Snapshots**

## Requirements

- VS Code 1.54.0 or higher

## Extension Settings

This extension contributes the following settings:

* `vibesync.excludePatterns`: Additional file/folder patterns to exclude from snapshots
* `vibesync.maxSnapshots`: Maximum number of snapshots to keep (oldest will be deleted automatically)

## Known Issues

- Large workspace snapshots may take some time to create and restore
- Snapshots are stored within the project directory by default
- External dependencies are not tracked

## Release Notes

### 0.0.1

- Initial release with basic snapshot functionality
- Sidebar view for managing snapshots
- Metadata and tagging system

---

**Enjoy!**
