# Azure DevOps Sync Helpers

A collection of command-line tools to help manage and synchronize Azure DevOps projects and processes across organizations.

## Prerequisites

- Node.js (v14 or higher)
- TypeScript
- An Azure DevOps Personal Access Token (PAT) with appropriate permissions
- `process-migrator` CLI tool (for process migration)

## Installation

1. Clone this repository
2. Install dependencies:
   ```powershell
   npm install
   ```

## Configuration

### Environment Setup

Edit `src/config.ts` to configure:

- **AZDO_PAT**: Your Azure DevOps Personal Access Token
- **SOURCE_ORG**: Default source organization name
- **TARGET_ORG**: Default target organization name
- **VISIBILITY**: Project visibility (`private` or `public`)
- **DRY_RUN**: Whether to run in dry-run mode (no actual changes)
- **organizations**: List of available organizations for interactive selection

Example:
```typescript
export const config = {
    AZDO_PAT: 'your-pat-token-here',
    SOURCE_ORG: 'STMN-Group',
    TARGET_ORG: 'STMN-Group-DEV',
    VISIBILITY: 'private',
    DRY_RUN: true,
    organizations: ['STMN-Group', 'STMN-Group-TEST', 'STMN-Group-DEV']
};
```

## Available Commands

### 1. List Projects

Lists all projects from the source organization.

```powershell
npm run list-projects
```

**Use case**: Quickly view all projects in the source organization before copying or migrating.

### 2. Copy Projects

Interactive tool to copy projects from a source organization to a target organization.

```powershell
npm run copy-projects
```

**Features**:
- Interactive organization selection
- Access validation for both source and target organizations
- Automatic process template matching or selection
- Handles existing projects (skip or recreate)
- Shows detailed summary before execution
- Supports dry-run mode

**Workflow**:
1. Select source and target organizations
2. Choose whether to run in dry-run mode
3. Select target process template
4. If projects already exist in target, choose to skip or recreate them
5. Review summary and confirm
6. Projects are created in the target organization

### 3. Migrate Process

Interactive tool to migrate a process template from one organization to another.

```powershell
npm run migrate-process
```

**Features**:
- Interactive organization and process selection
- Automatically updates `process-migrator-configuration.json`
- Supports custom target process names
- Uses the external `process-migrator` tool for actual migration

**Workflow**:
1. Select source and target organizations
2. Choose source process from available processes
3. Enter target process name (defaults to source process name)
4. Configuration file is updated
5. Process migration is executed via `process-migrator`


## Usage Examples

### Example 1: Copy All New Projects

```powershell
# Run in dry-run mode first to preview
npm run copy-projects

# Follow prompts:
# 1. Select source: STMN-Group
# 2. Select target: STMN-Group-DEV
# 3. Dry-run mode: Yes
# 4. Select process: Agile Straumann
# 5. Review summary

# If everything looks good, run again without dry-run
```

### Example 2: Migrate a Process Template

```powershell
npm run migrate-process

# Follow prompts:
# 1. Select source org: STMN-Group
# 2. Select target org: STMN-Group-DEV
# 3. Select source process: Agile Straumann
# 4. Enter target process name: Agile Straumann (or custom name)

# The tool will:
# - Update process-migrator-configuration.json
# - Run the process migrator to perform the migration
```

### Example 3: Recreate Existing Projects

```powershell
npm run copy-projects

# When prompted about existing projects:
# - Choose "No" to skip existing projects
# - This will delete and recreate projects with the selected process template
```

## Important Notes

### Personal Access Token (PAT)

Your PAT needs the following permissions:
- **Project and Team**: Read, Write, & Manage
- **Work Items**: Read & Write
- **Process**: Read & Write (for process migration)

### Dry-Run Mode

Always test with dry-run mode enabled first to preview changes without making actual modifications.

### JSON with Comments

The `process-migrator-configuration.json` file supports comments using `//`. This is handled by the `jsonc-parser` library, which allows for more readable configuration files.

### Process Templates

- Process templates must exist in the target organization before copying projects
- The tool attempts to match process templates by name
- If no match is found, the default process template is used

## Troubleshooting

### "Access Error" when running commands

- Verify your PAT token is valid and not expired
- Ensure the PAT has sufficient permissions
- Check that organization names are correct

### "Project already exists"

- Use the skip option to leave existing projects unchanged
- Use the recreate option to delete and recreate with new settings

### Process migration fails

- Ensure the `process-migrator` CLI tool is installed globally
- Check that the configuration file is valid
- Verify process names exist in source organization