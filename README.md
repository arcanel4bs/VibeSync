# VibeSync

<p align="center">
  <a href="https://youtu.be/uWS3CuDmTpA" target="_blank">
    <img src="./resources/vibesync_logo.png" alt="VibeSync Demo" width="400">
  </a>
</p>

<p align="center">
  <i>Click the image above to watch the demo video</i>
</p>


Made by: [Arcanel4bs](https://arcanel4bs.vercel.app/)


VibeSync is a VS Code extension that helps you manage your code by creating filesystem snapshots as "anchor points" or "snapshots" of the directory of your choice when your code is working well to save its state. If something breaks, you can easily respawn to a previous working state.


## Features

- **Save Snapshots**: Create named, timestamped snapshots of your current workspace
- **Restore Snapshots**: Revert to any previous working state with a single click
- **Metadata & Tags**: Add descriptions and tags to organize your snapshots
- **Dedicated Sidebar**: Easily browse and manage your saved snapshots
- **Automatic Backups**: Auto-backup before restoring to prevent data loss
- **Smart Filtering**: Excludes node_modules, .git, and other large directories from snapshots
- **Robust File Handling**: Uses advanced stream-based copying with retry logic for reliable restoration
- **Batch Processing**: Handles large workspaces with optimized batch restoration for better performance
- **Force Refresh**: Ensures VS Code fully refreshes all files after restoration



## Support

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Support%20the%20Project-yellow?style=for-the-badge&logo=buy-me-a-coffee)](https://buymeacoffee.com/arcanel4bs)

## Why VibeSync?

Ever got your code working perfectly, then you or a Coding Assistant like Cursor or Windsurf made a change that broke everything? VibeSync lets you:

- Respawn on a safe state at key development milestones
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
5. After restoration, you can choose to "Reopen Files" or "Force Refresh" to ensure VS Code properly recognizes all file changes

### Managing Snapshots

- View all snapshots in the dedicated sidebar
- Delete unwanted snapshots by right-clicking and selecting "Delete"
- View snapshot details by selecting it from the command palette with **VibeSync: Show All Snapshots**

### Advanced Options

- **Force Refresh**: If VS Code doesn't display the latest file content after restoring a snapshot, use Command Palette and select **VibeSync: Force Refresh Files**
- **Slow Mode Restoration**: For large workspaces, enable "Slow Mode" restoration in VS Code settings (`vibesync.useSlowRestore`) to process files in batches for improved reliability
- **Retry Attempts**: Adjust the number of retry attempts for problematic files using the `vibesync.maxRetryAttempts` setting

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

# Why not use git?
Modern problems require modern solutions and while you should definitely use git for version control, VibeSync is the solution for the rapid iteration that occurs when you code with an AI IDE coding assistant like Windsurf or Cursor.


Be aware that large files may take some time to create and restore
Some files may not be restored correctly
This service is still in experimental stage

## We apreciate your feedback at 
[Arcanel4bs](https://arcanel4bs.vercel.app/) 

[Twitter](https://twitter.com/labsarcane)

**Enjoy!**
