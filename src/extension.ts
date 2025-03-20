import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';

// Interface for workspace state metadata (formerly snapshot metadata)
interface WorkspaceStateMetadata {
  id: string;
  name: string;
  description?: string;
  timestamp: number;
  tags: string[];
  isIncremental?: boolean;
  baseStateId?: string;
  fileHashes?: Record<string, string>;
}

// Interface for workspace settings
interface WorkspaceInfo {
  path: string;
  name: string;
  lastSynced?: number;
  lastFullSnapshot?: string;
}

/**
 * Tree item representing a single workspace state (formerly snapshot)
 */
class WorkspaceStateTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly id: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly timestamp: number,
    public readonly isIncremental: boolean = false
  ) {
    super(label, collapsibleState);
    this.iconPath = new vscode.ThemeIcon(isIncremental ? 'diff' : 'history');
    
    // Format description with date and type
    const typeLabel = isIncremental ? '(Incremental)' : '(Full)';
    this.description = `${new Date(timestamp).toLocaleString()} ${typeLabel}`;
    
    // Add buttons for restore and delete in the tree item
    // Using a special context value ensures our commands appear correctly
    this.contextValue = 'workspaceState:editableState';
    
    // Add tooltip with more details
    this.tooltip = `${label} ${typeLabel} State (${new Date(timestamp).toLocaleString()})`;
    
    // Add command to handle click on the item itself (will show state details)
    this.command = {
      title: 'Show State Details',
      command: 'vibesync.noop',
      arguments: [this]
    };
  }
}

/**
 * Tree item for actions in the sidebar
 */
class ActionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly commandId: string,
    public readonly iconName: string,
    public readonly tooltip: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(iconName);
    this.tooltip = tooltip;
    this.command = {
      title: label,
      command: commandId,
      arguments: []
    };
  }
}

/**
 * Tree data provider for the VibeSync workspace states view (formerly snapshots)
 */
class WorkspaceStateProvider implements vscode.TreeDataProvider<WorkspaceStateTreeItem | ActionTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<WorkspaceStateTreeItem | ActionTreeItem | undefined | null | void> = 
    new vscode.EventEmitter<WorkspaceStateTreeItem | ActionTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<WorkspaceStateTreeItem | ActionTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
  
  constructor(private vibeSync: VibeSync) {}
  
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
  
  getTreeItem(element: WorkspaceStateTreeItem | ActionTreeItem): vscode.TreeItem {
    return element;
  }
  
  async getChildren(): Promise<(WorkspaceStateTreeItem | ActionTreeItem)[]> {
    const isInitialized = await this.vibeSync.isInitialized();
    
    if (!isInitialized) {
      // Return a "Select Folder" action if not initialized
      return [
        new ActionTreeItem(
          'Select a folder to VibeSync',
          'vibesync.selectFolder',
          'folder-active',
          'Choose the folder you want to snapshot and manage with VibeSync'
        )
      ];
    }
    
    // Add action buttons at the top
    const actions: ActionTreeItem[] = [
      new ActionTreeItem(
        'Save State',
        'vibesync.saveVibe',
        'add',
        'Save the current state of your project'
      )
    ];
    
    // Get workspace states (formerly snapshots)
    const workspaceStates = await this.vibeSync.getWorkspaceStates();
    if (workspaceStates.length === 0) {
      return [
        ...actions,
        new ActionTreeItem(
          'No states saved yet',
          'vibesync.noop',
          'info',
          'Create your first state with the button above'
        )
      ];
    }
    
    // Sort states by timestamp (newest first)
    const sortedWorkspaceStates = [...workspaceStates].sort((a, b) => b.timestamp - a.timestamp);
    
    // Map states to tree items
    const stateItems = sortedWorkspaceStates.map(metadata => new WorkspaceStateTreeItem(
      metadata.name,
      metadata.id,
      vscode.TreeItemCollapsibleState.None,
      metadata.timestamp,
      metadata.isIncremental === true
    ));
    
    return [...actions, ...stateItems];
  }
}

/**
 * Main class for the VibeSync extension
 */
class VibeSync {
  private workspaceStateMetadata: WorkspaceStateMetadata[] = [];
  private vibeDir?: string;
  private metadataFile?: string;
  private workspaceInfo?: WorkspaceInfo;
  private statusBarItem: vscode.StatusBarItem;
  private isRestoreInProgress: boolean = false;
  private isSaveInProgress: boolean = false;
  private lastOperation: number = 0;
  private readonly OPERATION_COOLDOWN_MS: number = 2000;
  private context: vscode.ExtensionContext;
  private workspaceInfoFile: string;
  
  constructor(context: vscode.ExtensionContext) {
    try {
      console.log('VibeSync constructor started');
      this.context = context;
      
      // Initialize storage for workspace info
      this.workspaceInfoFile = path.join(context.globalStorageUri.fsPath, 'workspaces.json');
      console.log('Workspace info file path:', this.workspaceInfoFile);
      
      try {
        fs.ensureFileSync(this.workspaceInfoFile);
        console.log('Workspace info file created or exists');
      } catch (error: any) {
        console.error('Error ensuring workspace info file:', error);
        // Continue with default values if file can't be created
      }
      
      // Try to load workspace info
      try {
        this.loadWorkspaceInfo();
        console.log('Workspace info loaded successfully');
      } catch (error: any) {
        console.error('Error loading workspace info (non-fatal):', error);
        // Continue with empty workspace info
      }
      
      // Create status bar item
      console.log('Creating status bar item');
      this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
      this.statusBarItem.command = 'vibesync.showSidebar';
      this.updateStatusBar();
      this.statusBarItem.show();
      context.subscriptions.push(this.statusBarItem);
      
      // Create tree view
      console.log('Creating workspace state tree provider');
      const workspaceStateProvider = new WorkspaceStateProvider(this);
      console.log('Creating tree view');
      const treeView = vscode.window.createTreeView('vibesync-states', {
        treeDataProvider: workspaceStateProvider,
        showCollapseAll: false
      });
      context.subscriptions.push(treeView);
      
      // Register commands
      console.log('Registering commands');
      context.subscriptions.push(
        vscode.commands.registerCommand('vibesync.selectFolder', this.selectFolder.bind(this, workspaceStateProvider)),
        vscode.commands.registerCommand('vibesync.saveVibe', this.saveVibe.bind(this, workspaceStateProvider)),
        vscode.commands.registerCommand('vibesync.restoreVibe', this.restoreVibe.bind(this)),
        vscode.commands.registerCommand('vibesync.listVibes', this.listVibes.bind(this)),
        vscode.commands.registerCommand('vibesync.deleteVibe', this.deleteVibe.bind(this, workspaceStateProvider)),
        vscode.commands.registerCommand('vibesync.showSidebar', () => {
          console.log('Running showSidebar command');
          Promise.resolve(vscode.commands.executeCommand('workbench.view.extension.vibesync-sidebar'))
            .then(() => console.log('Sidebar opened successfully'))
            .catch((err: Error) => console.error('Error opening sidebar:', err));
        }),
        vscode.commands.registerCommand('vibesync.noop', () => {
          // No operation command for UI elements that need a command but don't do anything
          console.log('Noop command executed');
        }),
        vscode.commands.registerCommand('vibesync.editStateName', this.editStateName.bind(this, workspaceStateProvider)),
        vscode.commands.registerCommand('vibesync.forceRefresh', this.forceRefreshFiles.bind(this))
      );
      
      // Initial check if we have a workspace open
      console.log('Checking workspace availability');
      setTimeout(() => {
        Promise.resolve(this.checkWorkspace(workspaceStateProvider))
          .then(() => {
            console.log('Workspace check completed successfully');
          })
          .catch((err: Error) => {
            console.error('Error checking workspace:', err);
          });
      }, 1000);
      
      console.log('VibeSync constructor completed successfully');
    } catch (error: any) {
      console.error('Error in VibeSync constructor:', error);
      vscode.window.showErrorMessage(`VibeSync initialization error: ${error.message}`);
      throw error; // Re-throw to ensure the error is visible in logs
    }
  }
  
  /**
   * Update the status bar with current sync status
   */
  private updateStatusBar(): void {
    try {
      if (this.workspaceInfo) {
        const lastSyncedStr = this.workspaceInfo.lastSynced 
          ? new Date(this.workspaceInfo.lastSynced).toLocaleString()
          : 'Never';
        
        this.statusBarItem.text = `$(history) VibeSync: ${path.basename(this.workspaceInfo.path)}`;
        this.statusBarItem.tooltip = `Last state: ${lastSyncedStr}\nClick to open VibeSync sidebar`;
      } else {
        this.statusBarItem.text = '$(history) VibeSync: Not Initialized';
        this.statusBarItem.tooltip = 'Click to select a folder to snapshot';
      }
    } catch (error: any) {
      console.error('Error updating status bar:', error);
    }
  }
  
  /**
   * Load workspace information
   */
  private loadWorkspaceInfo(): void {
    try {
      console.log('Loading workspace info from:', this.workspaceInfoFile);
      if (fs.existsSync(this.workspaceInfoFile)) {
        console.log('Workspace info file exists, reading content');
        const workspaces = fs.readJSONSync(this.workspaceInfoFile, { throws: false }) || [];
        console.log(`Found ${workspaces.length} workspaces in storage`);
        
        // Find active workspace - for now just use the last one
        if (workspaces.length > 0) {
          const lastWorkspace = workspaces[workspaces.length - 1];
          console.log('Using last workspace:', lastWorkspace.path);
          
          // Check if this workspace still exists
          if (fs.existsSync(lastWorkspace.path)) {
            console.log('Workspace path exists on disk');
            this.workspaceInfo = lastWorkspace;
            this.vibeDir = path.join(lastWorkspace.path, '.vibesync');
            this.metadataFile = path.join(this.vibeDir, 'metadata.json');
            console.log('VibeDir set to:', this.vibeDir);
            
            // Load metadata
            try {
              this.loadMetadata();
              console.log('Metadata loaded successfully');
            } catch (error: any) {
              console.error('Error loading metadata (non-fatal):', error);
            }
          } else {
            console.log('Workspace path no longer exists:', lastWorkspace.path);
          }
        }
      } else {
        console.log('No workspace info file exists yet');
      }
    } catch (error: any) {
      console.error('Error loading workspace info:', error);
      // Don't throw, allow the extension to continue with default values
    }
  }
  
  /**
   * Check if workspace is available and initialize
   */
  private async checkWorkspace(workspaceStateProvider: WorkspaceStateProvider): Promise<void> {
    try {
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 && !this.workspaceInfo) {
        const folderPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        
        // Ask user if they want to use the current workspace
        const result = await vscode.window.showInformationMessage(
          `Would you like to use the current workspace (${path.basename(folderPath)}) with VibeSync?`,
          'Yes',
          'No'
        );
        
        if (result === 'Yes') {
          await this.initializeWorkspace(folderPath, workspaceStateProvider);
        }
      }
    } catch (error: any) {
      console.error('Error in checkWorkspace:', error);
      throw error; // Propagate the error to be caught by caller
    }
  }
  
  /**
   * Allow user to select a folder to sync
   */
  async selectFolder(workspaceStateProvider: WorkspaceStateProvider): Promise<void> {
    const options: vscode.OpenDialogOptions = {
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select Folder to VibeSync'
    };
    
    const folderUri = await vscode.window.showOpenDialog(options);
    
    if (folderUri && folderUri.length > 0) {
      const folderPath = folderUri[0].fsPath;
      await this.initializeWorkspace(folderPath, workspaceStateProvider);
    }
  }
  
  /**
   * Initialize workspace for VibeSync
   */
  private async initializeWorkspace(folderPath: string, workspaceStateProvider: WorkspaceStateProvider): Promise<void> {
    try {
      // Set workspace info
      this.workspaceInfo = {
        path: folderPath,
        name: path.basename(folderPath)
      };
      
      // Set vibeDir
      this.vibeDir = path.join(folderPath, '.vibesync');
      this.metadataFile = path.join(this.vibeDir, 'metadata.json');
      
      // Create .vibesync directory if it doesn't exist
      fs.ensureDirSync(this.vibeDir);
      
      // Save workspace info
      await this.saveWorkspaceInfo();
      
      // Load existing metadata
      this.loadMetadata();
      
      // Update UI
      this.updateStatusBar();
      workspaceStateProvider.refresh();
      
      // Show sidebar
      vscode.commands.executeCommand('workbench.view.extension.vibesync-sidebar');
      
      vscode.window.showInformationMessage(`VibeSync initialized for folder: ${this.workspaceInfo.name}`);
    } catch (error: any) {
      console.error('Error initializing workspace:', error);
      vscode.window.showErrorMessage(`Failed to initialize VibeSync: ${error.message}`);
    }
  }
  
  /**
   * Check if VibeSync is initialized for a workspace
   */
  async isInitialized(): Promise<boolean> {
    return !!this.workspaceInfo && !!this.vibeDir;
  }
  
  /**
   * Load workspace information
   */
  private async saveWorkspaceInfo(): Promise<void> {
    try {
      console.log('Saving workspace info to:', this.workspaceInfoFile);
      // Read existing workspaces
      let workspaces: WorkspaceInfo[] = [];
      if (fs.existsSync(this.workspaceInfoFile)) {
        workspaces = fs.readJSONSync(this.workspaceInfoFile, { throws: false }) || [];
      }
      
      // Update or add current workspace
      if (this.workspaceInfo) {
        const existingIndex = workspaces.findIndex(w => w.path === this.workspaceInfo!.path);
        if (existingIndex >= 0) {
          workspaces[existingIndex] = this.workspaceInfo;
        } else {
          workspaces.push(this.workspaceInfo);
        }
        
        // Save to file
        console.log(`Saving ${workspaces.length} workspaces`);
        fs.writeJSONSync(this.workspaceInfoFile, workspaces, { spaces: 2 });
        console.log('Workspace info saved successfully');
      }
    } catch (error: any) {
      console.error('Error saving workspace info:', error);
    }
  }
  
  /**
   * Load workspace state metadata from disk
   */
  private loadMetadata(): void {
    try {
      if (this.metadataFile && fs.existsSync(this.metadataFile)) {
        this.workspaceStateMetadata = fs.readJSONSync(this.metadataFile);
      } else {
        this.workspaceStateMetadata = [];
      }
    } catch (error: any) {
      console.error('Error loading workspace state metadata:', error);
      this.workspaceStateMetadata = [];
    }
  }
  
  /**
   * Save workspace state metadata to disk
   */
  private saveWorkspaceStateMetadata(): void {
    try {
      if (this.metadataFile) {
        fs.writeJSONSync(this.metadataFile, this.workspaceStateMetadata, { spaces: 2 });
      }
    } catch (error: any) {
      console.error('Error saving workspace state metadata:', error);
    }
  }
  
  /**
   * Get all workspace states
   */
  async getWorkspaceStates(): Promise<WorkspaceStateMetadata[]> {
    return this.workspaceStateMetadata;
  }
  
  /**
   * Save current state as a new workspace state
   */
  async saveVibe(workspaceStateProvider: WorkspaceStateProvider) {
    if (!await this.isInitialized()) {
      const result = await vscode.window.showInformationMessage(
        'VibeSync is not initialized. Would you like to select a folder now?',
        'Yes',
        'No'
      );
      
      if (result === 'Yes') {
        await this.selectFolder(workspaceStateProvider);
      }
      
      if (!await this.isInitialized()) {
        return;
      }
    }
    
    const name = await vscode.window.showInputBox({ 
      prompt: 'Name this workspace state (e.g., "Login Worked State")',
      placeHolder: 'My Awesome Feature State'
    });
    
    if (!name) return; // User cancelled
    
    const description = await vscode.window.showInputBox({
      prompt: 'Add a description (optional)',
      placeHolder: 'Description of this working state'
    });
    
    const tagsInput = await vscode.window.showInputBox({
      prompt: 'Add tags separated by commas (optional)',
      placeHolder: 'feature, bugfix, refactor'
    });
    
    const tags = tagsInput ? tagsInput.split(',').map(tag => tag.trim()) : [];
    
    // Use the new simple snapshot method for better reliability
    await this.takeSimpleSnapshot(workspaceStateProvider, name, description, tags);
  }
  
  /**
   * Restore a selected workspace state
   */
  async restoreVibe(item?: WorkspaceStateTreeItem) {
    console.log('RestoreVibe started', item ? `with item: ${item.label} (${item.id})` : 'without item');
    try {
      if (!await this.isInitialized()) {
        console.log('VibeSync not initialized');
        vscode.window.showInformationMessage('VibeSync is not initialized. Please select a folder first.');
        return;
      }
      
      let id: string | undefined;
      
      // If called from the tree view
      if (item) {
        id = item.id;
        console.log(`Restoring workspace state from item: ${id}`);
      } else {
        // If called from the command palette
        console.log('Opening quick pick to select workspace state');
        const workspaceStates = this.workspaceStateMetadata.map(meta => ({
          label: meta.name,
          description: new Date(meta.timestamp).toLocaleString(),
          id: meta.id
        }));
        
        if (workspaceStates.length === 0) {
          console.log('No workspace states found');
          vscode.window.showInformationMessage('No workspace states found');
          return;
        }
        
        const selected = await vscode.window.showQuickPick(workspaceStates, {
          placeHolder: 'Pick a workspace state to restore'
        });
        
        if (!selected) {
          console.log('User cancelled workspace state selection');
          return; // User cancelled
        }
        id = selected.id;
        console.log(`Selected workspace state: ${selected.label} (${id})`);
      }
      
      // Use the new simple restore method for better reliability
      const result = await this.restoreSimpleSnapshot(id);
      
      if (!result) {
        vscode.window.showErrorMessage(`Failed to restore workspace state: ${id}`);
      }
    } catch (error: any) {
      console.error('Unexpected error in restoreVibe:', error);
      vscode.window.showErrorMessage(`Failed to restore workspace state: ${error.message}`);
    }
  }
  
  /**
   * List all available workspace states
   */
  async listVibes() {
    if (!await this.isInitialized()) {
      vscode.window.showInformationMessage('VibeSync is not initialized. Please select a folder first.');
      return;
    }
    
    if (this.workspaceStateMetadata.length === 0) {
      vscode.window.showInformationMessage('No workspace states found');
      return;
    }
    
    const quickPickItems = this.workspaceStateMetadata.map(meta => ({
      label: meta.name,
      description: new Date(meta.timestamp).toLocaleString(),
      detail: meta.description || 'No description',
      id: meta.id
    }));
    
    const selected = await vscode.window.showQuickPick(quickPickItems, {
      placeHolder: 'Select a workspace state to view details',
    });
    
    if (selected) {
      const workspaceState = this.workspaceStateMetadata.find(s => s.id === selected.id);
      if (workspaceState) {
        // Show workspace state details
        const tagsStr = workspaceState.tags.length > 0 ? `Tags: ${workspaceState.tags.join(', ')}` : 'No tags';
        vscode.window.showInformationMessage(
          `Workspace State: ${workspaceState.name}\nCreated: ${new Date(workspaceState.timestamp).toLocaleString()}\n${tagsStr}\n\n${workspaceState.description || 'No description'}`
        );
      }
    }
  }
  
  /**
   * Delete a workspace state
   */
  async deleteVibe(workspaceStateProvider: WorkspaceStateProvider, item?: WorkspaceStateTreeItem) {
    if (!await this.isInitialized()) {
      vscode.window.showInformationMessage('VibeSync is not initialized. Please select a folder first.');
      return;
    }
    
    let id: string | undefined;
    
    // If called from the tree view
    if (item) {
      id = item.id;
    } else {
      // If called from the command palette
      const workspaceStates = this.workspaceStateMetadata.map(meta => ({
        label: meta.name,
        description: new Date(meta.timestamp).toLocaleString(),
        id: meta.id
      }));
      
      if (workspaceStates.length === 0) {
        vscode.window.showInformationMessage('No workspace states found');
        return;
      }
      
      const selected = await vscode.window.showQuickPick(workspaceStates, {
        placeHolder: 'Pick a workspace state to delete'
      });
      
      if (!selected) return; // User cancelled
      id = selected.id;
    }
    
    // Find the workspace state
    const index = this.workspaceStateMetadata.findIndex(s => s.id === id);
    if (index === -1) {
      vscode.window.showErrorMessage(`Workspace state not found: ${id}`);
      return;
    }
    
    const workspaceState = this.workspaceStateMetadata[index];
    
    // Confirm deletion
    const confirmed = await vscode.window.showWarningMessage(
      `Are you sure you want to delete workspace state '${workspaceState.name}'?`,
      { modal: true },
      'Yes, Delete'
    );
    
    if (confirmed !== 'Yes, Delete') return;
    
    if (!this.vibeDir) {
      vscode.window.showErrorMessage('VibeSync is not properly initialized');
      return;
    }
    
    const snapshotDir = path.join(this.vibeDir!, workspaceState.id);
    
    try {
      if (fs.existsSync(snapshotDir)) {
        fs.removeSync(snapshotDir);
      }
      
      // Update metadata
      this.workspaceStateMetadata.splice(index, 1);
      this.saveWorkspaceStateMetadata();
      
      // Refresh the tree view
      workspaceStateProvider.refresh();
      
      vscode.window.showInformationMessage(`Workspace state deleted: ${workspaceState.name}`);
    } catch (error: any) {
      console.error('Error deleting workspace state:', error);
      vscode.window.showErrorMessage(`Failed to delete workspace state: ${error.message}`);
    }
  }
  
  /**
   * Calculate a hash for a file to determine if it has changed
   */
  private async calculateFileHash(filePath: string): Promise<string> {
    try {
      const fileContent = await fs.readFile(filePath);
      return crypto.createHash('md5').update(fileContent).digest('hex');
    } catch (error: any) {
      console.error(`Error calculating hash for ${filePath}:`, error);
      // Return a random hash to ensure the file is treated as changed
      return crypto.randomBytes(16).toString('hex');
    }
  }
  
  /**
   * Get all files in a directory recursively
   */
  private async getFilesRecursively(
    dirPath: string, 
    ignorePatterns: string[], 
    results: string[] = [],
    currentDepth: number = 0,
    maxDepth: number = 100
  ): Promise<string[]> {
    // Prevent infinite recursion
    if (currentDepth > maxDepth) {
      console.warn(`Maximum recursion depth reached at ${dirPath}`);
      return results;
    }
    
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        
        // Skip ignored patterns
        if (ignorePatterns.some(pattern => entry.name === pattern || 
                                 entryPath.includes(pattern))) {
          continue;
        }
        
        if (entry.isDirectory()) {
          await this.getFilesRecursively(
            entryPath, 
            ignorePatterns, 
            results, 
            currentDepth + 1,
            maxDepth
          );
        } else {
          results.push(entryPath);
        }
      }
      
      return results;
    } catch (error: any) {
      console.error(`Error reading directory ${dirPath}:`, error);
      return results;
    }
  }
  
  /**
   * Determine which files have changed since the last snapshot
   */
  private async getChangedFiles(
    basePath: string,
    lastSnapshotHashes: Record<string, string>,
    ignorePatterns: string[]
  ): Promise<{ changedFiles: string[], fileHashes: Record<string, string> }> {
    // Get all files in the workspace
    const allFiles = await this.getFilesRecursively(basePath, ignorePatterns);
    
    // Calculate hashes for all files
    const fileHashes: Record<string, string> = {};
    const changedFiles: string[] = [];
    
    // Calculate total size for progress reporting
    let totalSize = 0;
    for (const file of allFiles) {
      try {
        const stats = await fs.stat(file);
        totalSize += stats.size;
      } catch (error) {
        // Skip files that can't be stat'ed
        console.warn(`Couldn't get size of ${file}:`, error);
      }
    }
    
    // Create progress notification for hash calculation
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Analyzing files for changes...",
      cancellable: false
    }, async (progress) => {
      let processedSize = 0;
      
      for (const file of allFiles) {
        try {
          // Update progress
          try {
            const stats = await fs.stat(file);
            processedSize += stats.size;
            const percentage = Math.round((processedSize / totalSize) * 100);
            progress.report({ 
              message: `Analyzing file ${allFiles.indexOf(file) + 1}/${allFiles.length} (${percentage}%)`,
              increment: (stats.size / totalSize) * 100
            });
          } catch (error) {
            // Continue even if we can't calculate progress perfectly
          }
          
          // Calculate hash
          const hash = await this.calculateFileHash(file);
          const relativePath = path.relative(basePath, file);
          fileHashes[relativePath] = hash;
          
          // Check if file has changed or is new
          if (!lastSnapshotHashes[relativePath] || lastSnapshotHashes[relativePath] !== hash) {
            changedFiles.push(file);
          }
        } catch (error: any) {
          console.error(`Error processing file ${file}:`, error);
          // Treat as changed if we can't verify
          changedFiles.push(file);
        }
      }
    });
    
    // Check for deleted files
    for (const relativePath in lastSnapshotHashes) {
      const fullPath = path.join(basePath, relativePath);
      if (!fs.existsSync(fullPath)) {
        // File existed in previous snapshot but doesn't exist now
        // We'll track deletions by recording a hash but not including the file in changed files
        fileHashes[relativePath] = 'DELETED';
      }
    }
    
    return { changedFiles, fileHashes };
  }
  
  /**
   * Check if a project is too large and should use incremental snapshots
   */
  private async checkProjectSize(
    basePath: string, 
    ignorePatterns: string[]
  ): Promise<{ totalSize: number, isLarge: boolean, fileCount: number }> {
    // Define "large" as projects over 100MB or with more than 1000 files
    const LARGE_PROJECT_SIZE_THRESHOLD = 100 * 1024 * 1024; // 100MB
    const LARGE_PROJECT_FILE_COUNT_THRESHOLD = 1000;
    
    const allFiles = await this.getFilesRecursively(basePath, ignorePatterns);
    let totalSize = 0;
    
    for (const file of allFiles) {
      try {
        const stats = await fs.stat(file);
        totalSize += stats.size;
      } catch (error) {
        // Skip files that can't be stat'ed
      }
    }
    
    return {
      totalSize,
      fileCount: allFiles.length,
      isLarge: totalSize > LARGE_PROJECT_SIZE_THRESHOLD || 
               allFiles.length > LARGE_PROJECT_FILE_COUNT_THRESHOLD
    };
  }
  
  /**
   * Copy a file with retry mechanism for resilience 
   */
  private async copyFileWithRetry(src: string, dest: string, maxAttempts: number = 3): Promise<boolean> {
    let attempts = 0;
    
    while (attempts < maxAttempts) {
      try {
        // Make sure the destination directory exists
        fs.ensureDirSync(path.dirname(dest));
        
        // Copy the file
        fs.copyFileSync(src, dest);
        return true;
      } catch (error: any) {
        attempts++;
        console.error(`Error copying file (attempt ${attempts}/${maxAttempts}):`, error);
        
        // If this was the last attempt, return failure
        if (attempts >= maxAttempts) {
          return false;
        }
        
        // Wait a bit before retrying (exponential backoff)
        const delay = Math.min(100 * Math.pow(2, attempts), 2000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    return false;
  }
  
  /**
   * Delete file/directory with retry mechanism
   */
  private async removeWithRetry(targetPath: string, maxAttempts: number = 3): Promise<boolean> {
    let attempts = 0;
    
    while (attempts < maxAttempts) {
      try {
        await fs.remove(targetPath);
        return true;
      } catch (error: any) {
        attempts++;
        console.error(`Error removing ${targetPath} (attempt ${attempts}/${maxAttempts}):`, error);
        
        // If this was the last attempt, return failure
        if (attempts >= maxAttempts) {
          return false;
        }
        
        // Wait a bit before retrying (exponential backoff)
        const delay = Math.min(100 * Math.pow(2, attempts), 2000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    return false;
  }
  
  /**
   * Recursively copy a directory with improved error handling and progress reporting
   */
  private async simpleCopyDirectory(
    source: string,
    target: string,
    ignorePatterns: string[],
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    fileCountForProgress: number = 1
  ): Promise<{ copied: number, failed: number, fileList: string[] }> {
    // Create target directory if it doesn't exist
    fs.ensureDirSync(target);
    
    // Get all entries in the source directory
    const entries = await fs.readdir(source, { withFileTypes: true });
    
    let copiedCount = 0;
    let failedCount = 0;
    let processedCount = 0;
    const copiedFiles: string[] = [];
    
    // Process each entry
    for (const entry of entries) {
      const srcPath = path.join(source, entry.name);
      const destPath = path.join(target, entry.name);
      const relativePath = path.relative(source, srcPath);
      
      // Skip ignored patterns
      if (ignorePatterns.some(pattern => 
          entry.name === pattern || 
          srcPath.includes(`/${pattern}/`) || 
          srcPath.endsWith(`/${pattern}`) || 
          entry.name.match(new RegExp(`^${pattern.replace(/\*/g, '.*')}$`))
      )) {
        console.log(`Skipping ignored item: ${srcPath}`);
        continue;
      }
      
      try {
        if (entry.isDirectory()) {
          // Recursively copy subdirectory
          const result = await this.simpleCopyDirectory(
            srcPath, 
            destPath, 
            ignorePatterns,
            progress,
            fileCountForProgress
          );
          
          copiedCount += result.copied;
          failedCount += result.failed;
          copiedFiles.push(...result.fileList);
        } else {
          // Copy file with retry
          const success = await this.copyFileWithRetry(srcPath, destPath);
          
          if (success) {
            copiedCount++;
            copiedFiles.push(relativePath);
          } else {
            failedCount++;
            console.error(`Failed to copy file: ${srcPath}`);
          }
        }
        
        // Update progress periodically
        progress?.report({ 
          message: `Processed ${processedCount} items (${copiedCount} copied, ${failedCount} failed)`,
          increment: 100 / fileCountForProgress
        });
        
        processedCount++;
      } catch (error: any) {
        failedCount++;
        console.error(`Error processing ${srcPath}:`, error);
      }
    }
    
    return { copied: copiedCount, failed: failedCount, fileList: copiedFiles };
  }
  
  /**
   * Take a workspace state with a simpler, more reliable approach
   */
  async takeSimpleSnapshot(
    workspaceStateProvider: WorkspaceStateProvider,
    name: string, 
    description?: string, 
    tags: string[] = []
  ): Promise<boolean> {
    console.log(`Taking simple workspace state: ${name}`);
    
    if (!this.vibeDir || !this.workspaceInfo) {
      vscode.window.showErrorMessage('VibeSync is not properly initialized');
      return false;
    }
    
    // Check if we're within the cooldown period
    const now = Date.now();
    if (now - this.lastOperation < this.OPERATION_COOLDOWN_MS) {
      console.log('Operation cooldown period not yet passed');
      vscode.window.showErrorMessage('Please wait a bit before taking another snapshot');
      return false;
    }
    
    // Prevent overlapping operations
    if (this.isSaveInProgress) {
      console.log('Save operation already in progress');
      vscode.window.showErrorMessage('Save operation already in progress. Please wait for it to complete.');
      return false;
    }
    
    this.isSaveInProgress = true;
    this.lastOperation = now;
    
    // Generate a unique ID for the workspace state with timestamp for better sorting
    const timestamp = Date.now();
    const id = `state-${name.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase()}-${timestamp}`;
    const snapshotDir = path.join(this.vibeDir, id);
    
    // Define standard ignore patterns
    const ignorePatterns = [
      'node_modules',
      '.git',
      '.vibesync',
      'dist',
      'out',
      'build'
    ];
    
    // Get custom ignore patterns from settings
    const config = vscode.workspace.getConfiguration('vibesync');
    const customIgnores = config.get<string[]>('excludePatterns', []);
    
    // Combine ignore patterns
    let allIgnorePatterns = [...ignorePatterns, ...customIgnores];
    
    try {
      // Save any unsaved files before taking snapshot
      await vscode.workspace.saveAll(false);
      
      // Create workspace state directory
      fs.ensureDirSync(snapshotDir);
      
      // Add a manifest file with workspace state information
      const manifestData = {
        id,
        name,
        description: description || undefined,
        timestamp,
        tags: tags || [],
        workspacePath: this.workspaceInfo!.path,
        workspaceName: this.workspaceInfo!.name,
        ignorePatterns: allIgnorePatterns,
        versionInfo: {
          version: vscode.extensions.getExtension('vibesync')?.packageJSON.version || 'unknown',
          createdAt: new Date().toISOString()
        }
      };
      
      console.log(`Creating workspace state with metadata:`, {
        id,
        name,
        ignorePatterns: allIgnorePatterns,
        timestamp: new Date(timestamp).toISOString()
      });
      
      // Write manifest file
      fs.writeJSONSync(
        path.join(snapshotDir, '.vibesync-manifest.json'),
        manifestData,
        { spaces: 2 }
      );
      
      // Get all files in the workspace
      const allFiles = await this.getFilesRecursively(
        this.workspaceInfo!.path,
        allIgnorePatterns
      );
      
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Saving workspace state',
        cancellable: false
      }, async (progress) => {
        progress.report({ message: `Scanning workspace...` });
        
        console.log(`Found ${allFiles.length} files to snapshot`);
        
        progress.report({ 
          message: `Found ${allFiles.length} files to save`,
          increment: 10 
        });
        
        // Copy all files to the workspace state directory
        let copiedCount = 0;
        let errorCount = 0;
        
        for (const file of allFiles) {
          try {
            // Calculate the relative path from the workspace
            const relativePath = path.relative(this.workspaceInfo!.path, file);
            
            // Calculate the destination path in the snapshot
            const destPath = path.join(snapshotDir, relativePath);
            
            // Make sure the destination directory exists
            fs.ensureDirSync(path.dirname(destPath));
            
            // Copy the file
            fs.copyFileSync(file, destPath);
            copiedCount++;
            
            // Update progress periodically
            if (copiedCount % 10 === 0 || copiedCount === allFiles.length) {
              progress.report({ 
                message: `Saved ${copiedCount} of ${allFiles.length} files`,
                increment: 80 / allFiles.length * 10
              });
            }
          } catch (err) {
            console.error(`Error copying file ${file}:`, err);
            errorCount++;
          }
        }
        
        progress.report({ 
          message: `Saved ${copiedCount} files (${errorCount} errors)`,
          increment: 10
        });
        
        // Create metadata
        const metadata: WorkspaceStateMetadata = {
          id,
          name,
          description: description || undefined,
          timestamp,
          tags: tags || []
        };
        
        // Add to metadata list
        this.workspaceStateMetadata.push(metadata);
        this.saveWorkspaceStateMetadata();
        
        // Refresh the tree view
        workspaceStateProvider.refresh();
      });
      
      vscode.window.showInformationMessage(`Workspace state saved: ${name}! 🌀`);
      this.isSaveInProgress = false;
      return true;
    } catch (error: any) {
      console.error('Error saving workspace state:', error);
      vscode.window.showErrorMessage(`Failed to save workspace state: ${error.message}`);
      this.isSaveInProgress = false;
      return false;
    }
  }
  
  /**
   * Restore a workspace state with a more reliable approach
   */
  async restoreSimpleSnapshot(id: string): Promise<boolean> {
    console.log(`Restoring workspace state: ${id}`);
    
    if (!this.vibeDir || !this.workspaceInfo) {
      vscode.window.showErrorMessage('VibeSync is not properly initialized');
      return false;
    }
    
    // Check if we're within the cooldown period
    const now = Date.now();
    if (now - this.lastOperation < this.OPERATION_COOLDOWN_MS) {
      console.log('Operation cooldown period not yet passed');
      vscode.window.showErrorMessage('Please wait a bit before restoring another state');
      return false;
    }
    
    // Prevent overlapping operations
    if (this.isRestoreInProgress) {
      console.log('Restore operation already in progress');
      vscode.window.showErrorMessage('Restore operation already in progress. Please wait for it to complete.');
      return false;
    }
    
    this.isRestoreInProgress = true;
    this.lastOperation = now;
    
    // Get the snapshot directory
    const snapshotDir = path.join(this.vibeDir, id);
    
    if (!fs.existsSync(snapshotDir)) {
      vscode.window.showErrorMessage(`Workspace state '${id}' not found`);
      this.isRestoreInProgress = false;
      return false;
    }
    
    // Get the metadata
    let workspaceState;
    try {
      const metadata = fs.readJSONSync(path.join(snapshotDir, '.vibesync-manifest.json'));
      workspaceState = {
        id: metadata.id,
        name: metadata.name,
        description: metadata.description,
        timestamp: metadata.timestamp,
        tags: metadata.tags || []
      };
    } catch (err) {
      console.error('Error reading workspace state metadata:', err);
      vscode.window.showErrorMessage('Error reading workspace state metadata');
      this.isRestoreInProgress = false;
      return false;
    }
    
    // Confirm restoration
    const result = await vscode.window.showWarningMessage(
      `Are you sure you want to restore workspace state '${workspaceState.name}'? This will overwrite your current workspace files.`,
      { modal: true },
      'Yes, Restore'
    );
    
    if (result !== 'Yes, Restore') {
      this.isRestoreInProgress = false;
      return false;
    }
    
    try {
      // First, save all unsaved files to ensure no data loss
      await vscode.workspace.saveAll();
      
      // Close all text editors to prevent file locking issues
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      
      // Default ignore patterns
      const ignorePatterns = [
        'node_modules',
        '.git',
        '.vibesync',
        'dist',
        'out',
        'build'
      ];
      
      // Get settings
      const config = vscode.workspace.getConfiguration('vibesync');
      const customIgnores = config.get<string[]>('excludePatterns', []);
      const maxRetryAttempts = config.get<number>('maxRetryAttempts', 3);
      
      // Combine ignore patterns
      let allIgnorePatterns = [...ignorePatterns, ...customIgnores];
      
      // Check if manifest file exists for additional info
      const manifestFile = path.join(snapshotDir, '.vibesync-manifest.json');
      let manifest: any = null;
      
      if (fs.existsSync(manifestFile)) {
        try {
          manifest = fs.readJSONSync(manifestFile);
          console.log(`Found workspace state manifest:`, {
            id: manifest.id,
            name: manifest.name,
            timestamp: manifest.timestamp ? new Date(manifest.timestamp).toISOString() : 'unknown',
            version: manifest.versionInfo?.version || 'unknown'
          });
          
          if (manifest.ignorePatterns && Array.isArray(manifest.ignorePatterns)) {
            // Use ignore patterns from the snapshot itself
            console.log('Using ignore patterns from workspace state manifest:', manifest.ignorePatterns);
            allIgnorePatterns = manifest.ignorePatterns;
          }
        } catch (err) {
          console.error('Error reading manifest file:', err);
          // Continue with default ignore patterns
        }
      } else {
        console.warn(`No manifest file found for workspace state ${id} at ${manifestFile}`);
      }
      
      // Add a retry option to our restore method for handling tough cases
      const maxRetries = vscode.workspace.getConfiguration('vibesync').get('maxRetryAttempts', 3);
      
      // Function to attempt file copy with retries
      const copyFileWithRetry = async (sourcePath: string, destPath: string): Promise<boolean> => {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            // If not first attempt, add small delay to allow any locks to release
            if (attempt > 0) {
              await new Promise(resolve => setTimeout(resolve, 500 * attempt));
            }
            
            // If destination exists, try to delete it first
            if (fs.existsSync(destPath)) {
              fs.unlinkSync(destPath);
            }
            
            // Create needed subdirectories
            fs.ensureDirSync(path.dirname(destPath));
            
            // For problematic files, use advanced stream method with flush
            await new Promise<void>((resolve, reject) => {
              const readStream = fs.createReadStream(sourcePath);
              const writeStream = fs.createWriteStream(destPath, { flags: 'w' });
              
              readStream.on('error', (err) => {
                console.error(`Read stream error for ${sourcePath}:`, err);
                reject(err);
              });
              
              writeStream.on('error', (err) => {
                console.error(`Write stream error for ${destPath}:`, err);
                reject(err);
              });
              
              writeStream.on('finish', () => {
                // Force flush to ensure file is written completely
                writeStream.close(() => resolve());
              });
              
              readStream.pipe(writeStream);
            });
            
            // Verify the file exists
            if (!fs.existsSync(destPath)) {
              throw new Error('File not created properly');
            }
            
            return true;
          } catch (err) {
            console.error(`Error copying file (attempt ${attempt + 1}/${maxRetries + 1}):`, err);
            
            // If last attempt failed, propagate the error
            if (attempt === maxRetries) {
              return false;
            }
          }
        }
        
        return false;  // Should never reach here, but TypeScript wants a return
      };
      
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Restoring workspace state: ${workspaceState.name}`,
        cancellable: true
      }, async (progress, token) => {
        try {
          // STEP 1: Analyze files in workspace and snapshot
          progress.report({ message: 'Analyzing workspace and snapshot...' });
          
          // Get all files to manage during restore
          const snapshotFiles = await this.getFilesRecursively(snapshotDir, ['.vibesync-manifest.json', '.vibesync-base']);
          const workspaceFiles = await this.getFilesRecursively(this.workspaceInfo!.path, allIgnorePatterns);
          
          // Check if we should use slow batch mode based on file count
          const useBatchMode = 
            vscode.workspace.getConfiguration('vibesync').get('useSlowRestore', false) || 
            snapshotFiles.length > 1000;  // Auto-use for large workspaces
          
          // Calculate batch size based on workspace size
          let batchSize = 100;
          if (snapshotFiles.length > 5000) {
            batchSize = 50;
          } else if (snapshotFiles.length > 10000) {
            batchSize = 20;
          }
          
          progress.report({ 
            message: `Found ${snapshotFiles.length} files to restore, ${workspaceFiles.length} files to clean up`,
            increment: 5
          });
          
          // Check if user canceled during preparation
          if (token.isCancellationRequested) {
            vscode.window.showInformationMessage('Restore operation was cancelled.');
            this.isRestoreInProgress = false;
            return false;
          }
          
          // STEP 2: Delete existing files from workspace (except ignored ones)
          progress.report({ message: 'Preparing workspace...' });
          
          let deletedCount = 0;
          let deletionErrors = 0;
          
          // Delete non-ignored files in the workspace
          for (const file of workspaceFiles) {
            try {
              await fs.remove(file);
              deletedCount++;
              
              // Update progress periodically
              if (deletedCount % 10 === 0 || deletedCount === workspaceFiles.length) {
                progress.report({ 
                  message: `Removed ${deletedCount} of ${workspaceFiles.length} files`,
                  increment: 15 / workspaceFiles.length * 10
                });
              }
            } catch (err) {
              console.error(`Error removing file ${file}:`, err);
              deletionErrors++;
            }
          }
          
          progress.report({ 
            message: `Removed ${deletedCount} files (${deletionErrors} errors)`,
            increment: 10
          });
          
          // STEP 3: Copy files from snapshot to workspace
          progress.report({ message: 'Restoring files from workspace state...' });
          
          let copiedCount = 0;
          let copyErrors = 0;
          
          // If batch mode is enabled, process files in batches
          if (useBatchMode) {
            const totalBatches = Math.ceil(snapshotFiles.length / batchSize);
            
            for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
              if (token.isCancellationRequested) {
                vscode.window.showInformationMessage('Restore operation was cancelled.');
                this.isRestoreInProgress = false;
                return false;
              }
              
              const startIdx = batchIndex * batchSize;
              const endIdx = Math.min((batchIndex + 1) * batchSize, snapshotFiles.length);
              const batchFiles = snapshotFiles.slice(startIdx, endIdx);
              
              progress.report({ 
                message: `Processing batch ${batchIndex + 1}/${totalBatches} (${startIdx}-${endIdx} of ${snapshotFiles.length})`,
                increment: (50 / totalBatches) * 0.1 // Give 10% for batch start
              });
              
              // Process this batch
              for (const file of batchFiles) {
                try {
                  // Calculate relative path from the snapshot directory
                  const relativePath = path.relative(snapshotDir, file);
                  
                  // Skip manifest files
                  if (relativePath === '.vibesync-manifest.json' || relativePath === '.vibesync-base') {
                    continue;
                  }
                  
                  // Construct destination path in the workspace
                  const destPath = path.join(this.workspaceInfo!.path, relativePath);
                  
                  // Try to copy with retry logic for problematic files
                  const copied = await copyFileWithRetry(file, destPath);
                  
                  if (copied) {
                    copiedCount++;
                  } else {
                    copyErrors++;
                  }
                } catch (err) {
                  console.error(`Error copying file ${file}:`, err);
                  copyErrors++;
                }
              }
              
              // Update progress for this batch completion
              progress.report({ 
                message: `Batch ${batchIndex + 1}/${totalBatches} complete. Restored ${copiedCount} files so far (${copyErrors} errors)`,
                increment: (50 / totalBatches) * 0.9 // Give 90% for batch completion
              });
              
              // Short pause between batches to let VS Code refresh and avoid locking
              await new Promise(resolve => setTimeout(resolve, 500));
              
              // Force a partial refresh every few batches
              if (batchIndex % 5 === 4 || batchIndex === totalBatches - 1) {
                vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
              }
            }
          } else {
            // Process all files at once for smaller workspaces using the standard approach
            for (const file of snapshotFiles) {
              try {
                // Calculate relative path from the snapshot directory
                const relativePath = path.relative(snapshotDir, file);
                
                // Skip manifest files
                if (relativePath === '.vibesync-manifest.json' || relativePath === '.vibesync-base') {
                  continue;
                }
                
                // Construct destination path in the workspace
                const destPath = path.join(this.workspaceInfo!.path, relativePath);
                
                // Try to copy with retry logic for problematic files
                const copied = await copyFileWithRetry(file, destPath);
                
                if (copied) {
                  copiedCount++;
                } else {
                  copyErrors++;
                }
                
                // Update progress periodically
                if (copiedCount % 10 === 0 || copiedCount === snapshotFiles.length) {
                  progress.report({ 
                    message: `Restored ${copiedCount} of ${snapshotFiles.length} files (${copyErrors} errors)`,
                    increment: 50 / snapshotFiles.length * 10
                  });
                }
              } catch (err) {
                console.error(`Error copying file ${file}:`, err);
                copyErrors++;
              }
            }
          }
          
          progress.report({ 
            message: `Completed! Restored ${copiedCount} files with ${copyErrors} errors`,
            increment: 20
          });
          
          // Notify VS Code to refresh file explorer
          vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
          
          // Wait a moment for the file system to settle
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Force VS Code to fully reload by using a combination of approaches
          await vscode.commands.executeCommand('workbench.action.closeAllEditors');
          
          // Force a file system scan
          vscode.workspace.saveAll(false);
          vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
          
          // Use the text search to force cache invalidation
          try {
            await vscode.commands.executeCommand('workbench.action.findInFiles', {
              query: '',
              triggerSearch: true,
              matchWholeWord: false,
              isCaseSensitive: false
            });
            // Cancel the search immediately
            await vscode.commands.executeCommand('search.action.cancel');
          } catch (err) {
            // Ignore errors from the search command
            console.log('Search command error (expected, safe to ignore):', err);
          }
          
          // Wait a bit longer to ensure everything is refreshed
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Show success message with buttons for different options
          const choice = await vscode.window.showInformationMessage(
            `Workspace state '${workspaceState.name}' restored successfully! 🌟`,
            'Reopen Files',
            'Force Refresh'
          );
          
          if (choice === 'Reopen Files') {
            await vscode.commands.executeCommand('workbench.action.files.openFileFolder');
          } else if (choice === 'Force Refresh') {
            await this.forceRefreshFiles();
          }
          
          this.isRestoreInProgress = false;
          return true;
        } catch (error: any) {
          console.error('Error in restore progress:', error);
          vscode.window.showErrorMessage(`Error during restore: ${error.message}`);
          this.isRestoreInProgress = false;
          return false;
        }
      });
      
      if (!result) {
        vscode.window.showErrorMessage(`Failed to restore workspace state: ${id}`);
      }
      
      return result;
    } catch (error: any) {
      console.error('Error restoring workspace state:', error);
      vscode.window.showErrorMessage(`Failed to restore workspace state: ${error.message}`);
      this.isRestoreInProgress = false;
      return false;
    }
  }

  /**
   * Force VS Code to refresh/reload all files
   * This can help when the editor doesn't show the latest file content
   */
  private async forceRefreshFiles(): Promise<void> {
    // Close all editors first to release any file locks
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    
    // Save all files to ensure changes are flushed to disk
    await vscode.workspace.saveAll(false);
    
    // Force VS Code to refresh the file explorer
    vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
    
    // Trigger a search to force cache invalidation
    try {
      await vscode.commands.executeCommand('workbench.action.findInFiles', {
        query: '',
        triggerSearch: true,
        matchWholeWord: false,
        isCaseSensitive: false
      });
      
      // Cancel the search right away
      await vscode.commands.executeCommand('search.action.cancel');
    } catch (err) {
      // Ignore errors from search command
      console.log('Search command error (expected):', err);
    }
    
    // Rebuild IntelliSense caches
    vscode.commands.executeCommand('typescript.restartTsServer');
    
    // Wait a moment and open a random file to force file scan
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Show success message
    vscode.window.showInformationMessage('Files refreshed! All caches cleared.');
  }
  
  /**
   * Force VS Code to refresh all open editors after file changes
   */
  private async refreshOpenEditors(): Promise<void> {
    console.log('Refreshing open editors to reflect workspace state changes');
    
    // Get all open text editors
    const openEditors = vscode.window.visibleTextEditors;
    
    // Try two approaches to force VS Code to reload the files:
    
    // Approach 1: Use revert to reload from disk (most direct)
    for (const editor of openEditors) {
      try {
        const document = editor.document;
        if (document.uri.scheme === 'file' && fs.existsSync(document.uri.fsPath)) {
          console.log(`Reverting document to disk contents: ${document.uri.fsPath}`);
          await vscode.commands.executeCommand('workbench.action.files.revert', document.uri);
        }
      } catch (err) {
        console.error(`Error reverting document:`, err);
      }
    }
    
    // Approach 2: For each editor, reload the content from disk
    for (const editor of openEditors) {
      try {
        const document = editor.document;
        const uri = document.uri;
        
        // Check if this is a file that actually exists on disk (not an untitled file)
        if (uri.scheme === 'file') {
          console.log(`Refreshing editor for file: ${uri.fsPath}`);
          
          // First, check if the file still exists after restore
          if (fs.existsSync(uri.fsPath)) {
            // Create a new text document from the file
            const newDocument = await vscode.workspace.openTextDocument(uri);
            
            // Replace the editor with the reloaded document
            await vscode.window.showTextDocument(newDocument, { 
              viewColumn: editor.viewColumn, 
              preserveFocus: true,
              preview: false
            });
          } else {
            console.log(`File no longer exists after restore: ${uri.fsPath}`);
          }
        }
      } catch (err) {
        console.error(`Error refreshing editor:`, err);
      }
    }
    
    // For good measure, force a workspace file system scan
    vscode.workspace.saveAll(false);
    
    // Wait a moment to let VS Code settle
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  /**
   * Edit the name of a workspace state
   */
  private async editStateName(workspaceStateProvider: WorkspaceStateProvider, item?: WorkspaceStateTreeItem) {
    if (!item) {
      vscode.window.showErrorMessage('Please select a workspace state to edit.');
      return;
    }

    const newStateName = await vscode.window.showInputBox({
      prompt: 'Enter new name for workspace state:',
      value: item.label // Suggest current name as default value
    });

    if (newStateName !== undefined) { // User did not cancel
      if (!newStateName.trim()) {
        vscode.window.showErrorMessage('Workspace state name cannot be empty.');
        return;
      }

      const stateId = item.id;
      const stateIndex = this.workspaceStateMetadata.findIndex(state => state.id === stateId);
      if (stateIndex !== -1) {
        this.workspaceStateMetadata[stateIndex].name = newStateName.trim();
        this.saveWorkspaceStateMetadata();
        workspaceStateProvider.refresh();
        vscode.window.showInformationMessage(`Workspace state name updated to: ${newStateName.trim()}`);
      } else {
        vscode.window.showErrorMessage('Workspace state not found in metadata.');
      }
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Activating VibeSync extension');
  
  try {
    // Create the main extension instance
    const vibeSync = new VibeSync(context);
    console.log('VibeSync instance created successfully');
    
    // Keep a reference in global state for debugging
    context.globalState.update('vibeSync', 'active');
    
    // Setup a keepalive interval to prevent the extension from being garbage collected
    const keepAliveInterval = setInterval(() => {
      console.log('VibeSync keepalive check - extension is still running');
    }, 5000);

    // Make sure to clean up when deactivated
    context.subscriptions.push({
      dispose: () => {
        console.log('Disposing keepalive interval');
        clearInterval(keepAliveInterval);
      }
    });
    
    // Add a notification to show the extension is ready
    setTimeout(() => {
      vscode.window.showInformationMessage('VibeSync is ready! Use the sidebar to manage your workspace states.');
    }, 2000);
    
    console.log('VibeSync activation completed successfully');
    return vibeSync; // Returning the instance helps keep it from being garbage collected
  } catch (error: any) {
    console.error('Fatal error during VibeSync activation:', error);
    vscode.window.showErrorMessage(`VibeSync failed to activate: ${error.message}`);
  }
}

// This method is called when your extension is deactivated
export function deactivate() {
  console.log('VibeSync extension is being deactivated');
  // Perform any cleanup here if needed
}