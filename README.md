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

### 3. Copy Work Items

Interactive tool to copy an Epic and all its child work items from one organization to another with enhanced field validation and identity management.

```powershell
npm run copy-workitems
```

**Features**:
- Copy entire Epic hierarchies with all child work items
- Advanced field validation with allowed values handling
- Automatic identity field error handling and retry logic
- Smart field value mapping between organizations
- Work item type mapping for missing types
- Automatic user management (add as stakeholders/basic users)
- Batch processing for large work item sets
- Progress tracking and detailed logging

**Enhanced Field Handling**:
- **String fields with allowed values**: Automatically adds "Other" value when source value isn't allowed
- **Numeric fields**: Finds closest matching value from allowed values
- **Identity fields**: Handles unknown identities by retrying without problematic fields
- **Work item type fields**: Fetches detailed field information with expanded allowed values

**Workflow**:
1. Select source and target organizations and projects
2. Enter Epic ID to copy (with all children)
3. Handle missing work item types (skip or map to existing types)
4. Configure default value usage and user access levels
5. Review summary and confirm
6. Work items are created with proper field validation and relationships

### 4. Copy Work Item Type

Tool to copy work item type definitions between projects.

```powershell
npm run copy-workitemtype
```

**Use case**: Copy custom work item type definitions to maintain consistency across projects.

### 5. Change Work Item Types

Tool to bulk change work item types within a project.

```powershell
npm run change-workitem-types
```

**Use case**: Convert existing work items from one type to another (e.g., Task to User Story).

### 6. Migrate Process

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

### Example 3: Copy Work Items with Enhanced Field Handling

```powershell
npm run copy-workitems

# Follow prompts:
# 1. Select source: STMN-Group / Project A
# 2. Select target: STMN-Group-DEV / Project B
# 3. Enter Epic ID: 12345
# 4. Handle missing work item types (map Task to User Story)
# 5. Configure field defaults: Yes
# 6. User handling: Add as Stakeholders
# 7. Review summary showing field mappings and user additions

# The tool will:
# - Copy Epic 12345 and all its children
# - Handle field validation automatically
# - Add "Other" values for incompatible string fields
# - Find closest numeric values for number fields
# - Retry creation if identity fields fail
# - Maintain parent-child relationships
```

### Example 4: Recreate Existing Projects

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
- **Member Entitlement Management**: Read & Write (for adding users to organizations)
- **Identity**: Read (for user identity validation)

### Dry-Run Mode

Always test with dry-run mode enabled first to preview changes without making actual modifications.

### JSON with Comments

The `process-migrator-configuration.json` file supports comments using `//`. This is handled by the `jsonc-parser` library, which allows for more readable configuration files.

### Process Templates

- Process templates must exist in the target organization before copying projects
- The tool attempts to match process templates by name
- If no match is found, the default process template is used

### Work Item Field Validation

The copy-workitems tool includes advanced field validation:

**Allowed Values Handling**:
- Fetches detailed field information with `$expand=all` for accurate validation
- For string fields: Automatically adds "Other" value when source value isn't in target's allowed values
- For numeric fields: Finds the closest matching value from target's allowed values
- For other field types: Uses intelligent defaults or first allowed value

**Identity Field Management**:
- Detects identity field errors (unknown users in target organization)
- Automatically retries work item creation without problematic identity fields
- Can optionally add missing users as Stakeholders or Basic users
- Preserves work item creation even when identity validation fails

**Work Item Type Mapping**:
- Handles missing work item types by allowing mapping to existing types
- Maintains field compatibility during type conversion
- Provides interactive selection for type mappings

**Batch Processing**:
- Splits large work item requests into batches of 190 items (under Azure DevOps 200 limit)
- Shows progress indicators for large hierarchies
- Maintains performance for Epic trees with hundreds of work items

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

### Work item copying issues

**"Identity field error" or "unknown identity"**:
- This is automatically handled by the retry logic
- Check if users exist in the target organization
- Consider using "Add as Stakeholders" option to automatically add missing users

**"Field value not allowed" errors**:
- The tool automatically handles this by adding "Other" values or finding closest matches
- Ensure you have Process permissions to modify field allowed values
- Check that the process ID is correctly retrieved from the target project

**"Work item type not found"**:
- Use the type mapping feature to map missing types to existing ones
- Consider migrating the process template first to ensure all work item types exist

**Large Epic hierarchies taking too long**:
- The tool processes in batches automatically
- Monitor progress indicators - processing hundreds of work items can take several minutes
- Network timeouts may occur - retry the operation if needed