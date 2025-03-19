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
  private vibeDir: string | undefined;
  private metadataFile: string | undefined;
  private workspaceStateMetadata: WorkspaceStateMetadata[] = [];
  private workspaceInfo: WorkspaceInfo | undefined;
  private workspaceInfoFile: string;
  private context: vscode.ExtensionContext;
  private statusBarItem: vscode.StatusBarItem;
  
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
        vscode.commands.registerCommand('vibesync.editStateName', this.editStateName.bind(this, workspaceStateProvider))
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
  private saveMetadata(): void {
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
      await this.restoreSimpleSnapshot(id);
      
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
      this.saveMetadata();
      
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
          srcPath.includes(pattern) || 
          entry.name.match(new RegExp(pattern.replace('*', '.*')))
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
        
        // Update progress if available
        processedCount++;
        if (progress) {
          progress.report({
            message: `Processed ${processedCount} items (${copiedCount} copied, ${failedCount} failed)`,
            increment: 100 / fileCountForProgress
          });
        }
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
    const allIgnorePatterns = [...ignorePatterns, ...customIgnores];
    
    try {
      // Create workspace state directory
      fs.ensureDirSync(snapshotDir);
      
      // Add a manifest file with workspace state information
      const manifestData = {
        id,
        name,
        description,
        timestamp,
        tags,
        workspacePath: this.workspaceInfo.path,
        workspaceName: this.workspaceInfo.name,
        ignorePatterns: allIgnorePatterns
      };
      
      // Write manifest file
      fs.writeJSONSync(
        path.join(snapshotDir, '.vibesync-manifest.json'), 
        manifestData, 
        { spaces: 2 }
      );
      
      // First get all files to copy for better progress reporting
      const allFiles = await this.getFilesRecursively(this.workspaceInfo.path, allIgnorePatterns);
      
      // Create progress notification
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Creating workspace state: ${name}`,
        cancellable: false
      }, async (progress) => {
        progress.report({ message: 'Preparing to copy files...' });
        
        // Use the improved copy function
        const copyResult = await this.simpleCopyDirectory(
          this.workspaceInfo!.path, 
          snapshotDir, 
          allIgnorePatterns,
          progress,
          allFiles.length
        );
        
        // Report results
        console.log(`Workspace state copy complete: ${copyResult.copied} files copied, ${copyResult.failed} failed`);
        
        if (copyResult.failed > 0) {
          vscode.window.showWarningMessage(
            `Warning: ${copyResult.failed} files could not be copied to the workspace state.`
          );
        }
        
        // Create metadata
        const metadata: WorkspaceStateMetadata = {
          id,
          name,
          description: description || undefined,
          timestamp,
          tags,
          isIncremental: false,  // Simple snapshots are always full
          fileHashes: {}  // We don't use hashes in simple snapshots
        };
        
        // Save metadata
        this.workspaceStateMetadata.push(metadata);
        this.saveMetadata();
        
        // Update workspace info
        if (this.workspaceInfo) {
          this.workspaceInfo.lastSynced = timestamp;
          this.workspaceInfo.lastFullSnapshot = id;
          await this.saveWorkspaceInfo();
          this.updateStatusBar();
        }
        
        // Refresh the tree view
        workspaceStateProvider.refresh();
      });
      
      vscode.window.showInformationMessage(`Workspace state saved: ${name}! 🌀`);
      return true;
    } catch (error: any) {
      console.error('Error taking workspace state:', error);
      vscode.window.showErrorMessage(`Failed to take workspace state: ${error.message}`);
      
      // Clean up on failure
      if (fs.existsSync(snapshotDir)) {
        fs.removeSync(snapshotDir);
      }
      
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
    
    // Find the workspace state metadata
    const workspaceState = this.workspaceStateMetadata.find(s => s.id === id);
    if (!workspaceState) {
      vscode.window.showErrorMessage(`Workspace state not found: ${id}`);
      return false;
    }
    
    // Full path to the workspace state directory
    const snapshotDir = path.join(this.vibeDir, workspaceState.id);
    
    // Check if workspace state directory exists
    if (!fs.existsSync(snapshotDir)) {
      vscode.window.showErrorMessage(`Workspace state directory not found: ${workspaceState.id}`);
      return false;
    }
    
    // Confirm restore with the user
    const result = await vscode.window.showWarningMessage(
      `Are you sure you want to restore workspace state '${workspaceState.name}'? This will overwrite your current workspace files.`,
      { modal: true },
      'Yes, Restore'
    );
    
    if (result !== 'Yes, Restore') {
      return false;
    }
    
    try {
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
      const allIgnorePatterns = [...ignorePatterns, ...customIgnores];
      
      // Check if manifest file exists for additional info
      const manifestFile = path.join(snapshotDir, '.vibesync-manifest.json');
      if (fs.existsSync(manifestFile)) {
        try {
          const manifest = fs.readJSONSync(manifestFile);
          if (manifest.ignorePatterns && Array.isArray(manifest.ignorePatterns)) {
            // Use ignore patterns from the snapshot itself
            console.log('Using ignore patterns from workspace state manifest');
          }
        } catch (err) {
          console.error('Error reading manifest file:', err);
          // Continue with default ignore patterns
        }
      }
      
      // Create a temporary staging directory to prepare the restore
      // This allows us to be more atomic in our approach
      const stagingDir = path.join(this.vibeDir, `restore-staging-${Date.now()}`);
      
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Restoring workspace state: ${workspaceState.name}`,
        cancellable: false
      }, async (progress) => {
        // STEP 1: Gather information about what files exist in the workspace
        progress.report({ message: 'Analyzing workspace files...' });
        
        const workspaceFiles = await this.getFilesRecursively(
          this.workspaceInfo!.path, 
          allIgnorePatterns
        );
        
        progress.report({ 
          message: `Found ${workspaceFiles.length} files in workspace`,
          increment: 10 
        });
        
        // STEP 2: Gather information about what files exist in the workspace state
        progress.report({ message: 'Analyzing workspace state files...' });
        
        // Get all files in the workspace state, excluding any ignore patterns and manifest files
        const snapshotFiles = await this.getFilesRecursively(
          snapshotDir, 
          ['.vibesync-manifest.json', '.vibesync-base']
        );
        
        progress.report({ 
          message: `Found ${snapshotFiles.length} files in workspace state`,
          increment: 10 
        });
        
        // STEP 3: Create the staging directory with a partial workspace structure
        progress.report({ message: 'Preparing staging area...' });
        fs.ensureDirSync(stagingDir);
        
        // STEP 4: Copy files from the workspace state to the staging area
        progress.report({ message: 'Copying workspace state files to staging area...' });
        
        const result = await this.simpleCopyDirectory(
          snapshotDir,
          stagingDir,
          ['.vibesync-manifest.json', '.vibesync-base'],
          progress,
          snapshotFiles.length
        );
        
        if (result.failed > 0) {
          vscode.window.showWarningMessage(
            `Warning: ${result.failed} files could not be copied from the workspace state.`
          );
        }
        
        progress.report({ 
          message: `Copied ${result.copied} files to staging area (${result.failed} failed)`,
          increment: 30
        });
        
        // STEP 5: Remove existing files from workspace (except ignored ones)
        progress.report({ message: 'Removing existing workspace files...' });
        
        let deletedCount = 0;
        let failedDeletions = 0;
        
        const workspaceEntries = fs.readdirSync(this.workspaceInfo!.path, { withFileTypes: true });
        
        for (const entry of workspaceEntries) {
          if (allIgnorePatterns.includes(entry.name)) {
            console.log(`Skipping ignored item: ${entry.name}`);
            continue;
          }
          
          const entryPath = path.join(this.workspaceInfo!.path, entry.name);
          console.log(`Removing workspace item: ${entryPath}`);
          
          try {
            const success = await this.removeWithRetry(entryPath, maxRetryAttempts);
            if (success) {
              deletedCount++;
            } else {
              failedDeletions++;
              console.error(`Failed to remove ${entryPath} after ${maxRetryAttempts} attempts`);
            }
          } catch (err) {
            failedDeletions++;
            console.error(`Error removing ${entryPath}:`, err);
          }
        }
        
        if (failedDeletions > 0) {
          const msg = `Warning: ${failedDeletions} items could not be removed from workspace.`;
          console.warn(msg);
          vscode.window.showWarningMessage(msg);
        }
        
        progress.report({ 
          message: `Removed ${deletedCount} items from workspace (${failedDeletions} failed)`, 
          increment: 10 
        });
        
        // STEP 6: Copy files from staging to workspace
        progress.report({ message: 'Copying files to workspace...' });
        
        const stagingEntries = fs.readdirSync(stagingDir, { withFileTypes: true });
        let copiedCount = 0;
        let copyFailures = 0;
        
        for (const entry of stagingEntries) {
          const srcPath = path.join(stagingDir, entry.name);
          const destPath = path.join(this.workspaceInfo!.path, entry.name);
          
          try {
            if (entry.isDirectory()) {
              // Copy directory recursively
              const copyResult = await this.simpleCopyDirectory(
                srcPath,
                destPath,
                []
              );
              
              copiedCount += copyResult.copied;
              copyFailures += copyResult.failed;
            } else {
              // Copy file with retry
              const success = await this.copyFileWithRetry(srcPath, destPath, maxRetryAttempts);
              if (success) {
                copiedCount++;
              } else {
                copyFailures++;
              }
            }
          } catch (err) {
            copyFailures++;
            console.error(`Error copying ${srcPath} to workspace:`, err);
          }
          
          // Update progress periodically
          progress.report({ 
            message: `Restored ${copiedCount} files (${copyFailures} failed)`,
            increment: 30 / stagingEntries.length
          });
        }
        
        // STEP 7: Cleanup staging directory
        progress.report({ message: 'Cleaning up...' });
        
        try {
          await fs.remove(stagingDir);
        } catch (err) {
          console.error('Error removing staging directory:', err);
          // Non-fatal error, continue
        }
        
        // Update workspace info
        if (this.workspaceInfo) {
          this.workspaceInfo.lastSynced = Date.now();
          await this.saveWorkspaceInfo();
          this.updateStatusBar();
        }
        
        progress.report({ 
          message: `Restore complete: ${copiedCount} files restored (${copyFailures} failed)`,
          increment: 10 
        });
      });
      
      vscode.window.showInformationMessage(`Workspace state '${workspaceState.name}' restored successfully! 🌟`);
      return true;
    } catch (error: any) {
      console.error('Error restoring workspace state:', error);
      vscode.window.showErrorMessage(`Failed to restore workspace state: ${error.message}`);
      return false;
    }
  }

  /**
   * Edit the name of a workspace state
   */
  async editStateName(workspaceStateProvider: WorkspaceStateProvider, item?: WorkspaceStateTreeItem) {
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
        this.saveMetadata();
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