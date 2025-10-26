import { fileURLToPath } from 'url';
import { config } from './config.ts';
import { validateAccess } from './auth.ts';
import { listProjects } from './sync-projects.ts';
import inquirer from 'inquirer';
import { getHeaders, getHeadersJson, API_VER, startProgress, stopProgress } from './shared-utils.ts';

// Types for Azure DevOps Work Items API
interface WorkItem {
    id: number;
    rev: number;
    fields: { [key: string]: any };
    relations?: WorkItemRelation[];
    url: string;
}

interface WorkItemRelation {
    rel: string;
    url: string;
    attributes?: { [key: string]: any };
}

interface WorkItemType {
    name: string;
    description: string;
    color: string;
    icon: string;
    isDisabled: boolean;
}

interface Project {
    id: string;
    name: string;
    description?: string;
    state: string;
}

interface WiqlQuery {
    query: string;
}

interface WiqlResult {
    queryType: string;
    queryResultType: string;
    asOf: string;
    columns: WiqlColumn[];
    workItems: WiqlWorkItem[];
    workItemRelations?: WiqlWorkItemRelation[];
}

interface WiqlColumn {
    referenceName: string;
    name: string;
    url: string;
}

interface WiqlWorkItem {
    id: number;
    url: string;
}

interface WiqlWorkItemRelation {
    target: WiqlWorkItem;
    source?: WiqlWorkItem;
    rel?: string;
}

interface ChangeConfig {
    org: string;
    project: string;
    originalType: string;
    targetType: string;
    dryRun: boolean;
}

// Get work item types for a project
async function getWorkItemTypes(org: string, project: string): Promise<WorkItemType[]> {
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/${project}/_apis/wit/workitemtypes`);
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Get work item types (${org}/${project}): ${res.statusText}`);

    const body = await res.json();
    return body.value;
}

// Execute WIQL query to find work items
async function executeWiqlQuery(org: string, project: string, wiql: string): Promise<WiqlResult> {
    const headers = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/${project}/_apis/wit/wiql`);
    url.searchParams.set('api-version', API_VER);

    const payload: WiqlQuery = { query: wiql };

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Execute WIQL query failed (${org}/${project}): ${res.status} ${errorText}`);
    }

    return res.json();
}

// Get multiple work items by IDs
async function getWorkItemsBatch(org: string, project: string, ids: number[]): Promise<WorkItem[]> {
    if (ids.length === 0) return [];
    
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/${project}/_apis/wit/workitems`);
    url.searchParams.set('ids', ids.join(','));
    url.searchParams.set('$expand', 'relations');
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Get work items batch (${org}/${project}): ${res.statusText}`);

    const body = await res.json();
    return body.value || [];
}

// Update work item type
async function updateWorkItemType(org: string, project: string, workItemId: number, newType: string): Promise<WorkItem> {
    const headers = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/${project}/_apis/wit/workitems/${workItemId}`);
    url.searchParams.set('api-version', API_VER);

    const patchDocument = [
        {
            op: 'add',
            path: '/fields/System.WorkItemType',
            value: newType
        }
    ];

    const res = await fetch(url, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify(patchDocument)
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Update work item type failed (${org}/${project}/${workItemId}): ${res.status} ${errorText}`);
    }

    return res.json();
}

// Find all work items of a specific type
async function findWorkItemsByType(org: string, project: string, workItemType: string): Promise<WorkItem[]> {
    // WIQL query to find all work items of the specified type
    const wiql = `
        SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], [System.AssignedTo]
        FROM WorkItems
        WHERE [System.TeamProject] = @project
        AND [System.WorkItemType] = '${workItemType}'
        ORDER BY [System.Id] ASC
    `;

    try {
        // Execute the query
        const queryResult = await executeWiqlQuery(org, project, wiql);
        
        // Extract work item IDs
        const workItemIds = queryResult.workItems.map(wi => wi.id);
        
        if (workItemIds.length === 0) {
            console.log(`   ℹ️  No work items found with type "${workItemType}"`);
            return [];
        }

        console.log(`   ✓ Found ${workItemIds.length} work items of type "${workItemType}"`);
        
        // Fetch full work item details in batches (API limit is typically 200 per request)
        const batchSize = 200;
        const allWorkItems: WorkItem[] = [];
        
        for (let i = 0; i < workItemIds.length; i += batchSize) {
            const batch = workItemIds.slice(i, i + batchSize);
            const batchWorkItems = await getWorkItemsBatch(org, project, batch);
            allWorkItems.push(...batchWorkItems);
        }
        
        return allWorkItems;
        
    } catch (error) {
        throw new Error(`Failed to find work items by type "${workItemType}": ${error instanceof Error ? error.message : String(error)}`);
    }
}

// Interactive configuration
async function getChangeConfig(): Promise<ChangeConfig> {
    // Validate access first
    console.log('Validating access to organizations...');
    const firstOrg = config.organizations[0] || 'STMN-Group';
    const accessResult = await validateAccess(firstOrg, firstOrg);
    if (!accessResult.hasAccess) {
        console.error('❌ Access Error:', accessResult.error);
        process.exit(1);
    }
    console.log('✓ Access validated successfully\n');

    // Get organization selection
    const orgAnswer = await inquirer.prompt([
        {
            type: 'list',
            name: 'org',
            message: 'Select the target organization:',
            choices: config.organizations
        }
    ]);

    // Get projects for selected org
    console.log(`\nFetching projects from ${orgAnswer.org}...`);
    const projects = await listProjects(orgAnswer.org);
    const projectChoices = projects
        .map(p => ({ name: p.name, value: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const projectAnswer = await inquirer.prompt([
        {
            type: 'list',
            name: 'project',
            message: 'Select the target project:',
            choices: projectChoices
        }
    ]);

    // Get work item types for the project
    console.log(`\nFetching work item types from ${orgAnswer.org}/${projectAnswer.project}...`);
    const workItemTypes = await getWorkItemTypes(orgAnswer.org, projectAnswer.project);
    const typeChoices = workItemTypes
        .filter(t => !t.isDisabled)
        .map(t => ({ name: `${t.name} - ${t.description || 'No description'}`, value: t.name }))
        .sort((a, b) => a.value.localeCompare(b.value));

    const typeAnswers = await inquirer.prompt([
        {
            type: 'list',
            name: 'originalType',
            message: 'Select the original work item type to change FROM:',
            choices: typeChoices
        },
        {
            type: 'list',
            name: 'targetType',
            message: 'Select the target work item type to change TO:',
            choices: typeChoices,
            validate: (input, answers) => {
                if (input === answers.originalType) {
                    return 'Target type must be different from original type';
                }
                return true;
            }
        },
        {
            type: 'confirm',
            name: 'dryRun',
            message: 'Do you want to do a dry run first? (Recommended)',
            default: true
        }
    ]);

    return {
        org: orgAnswer.org,
        project: projectAnswer.project,
        originalType: typeAnswers.originalType,
        targetType: typeAnswers.targetType,
        dryRun: typeAnswers.dryRun
    };
}

// Main change function
async function changeWorkItemTypes(): Promise<void> {
    try {
        const changeConfig = await getChangeConfig();

        console.log('\n📋 Change Configuration:');
        console.log(`Organization: ${changeConfig.org}`);
        console.log(`Project: ${changeConfig.project}`);
        console.log(`Change FROM: ${changeConfig.originalType}`);
        console.log(`Change TO: ${changeConfig.targetType}`);
        console.log(`Dry Run: ${changeConfig.dryRun ? 'Yes' : 'No'}\n`);

        // Find all work items of the original type
        const findTimer = startProgress('🔍 Finding work items of original type');
        const workItems = await findWorkItemsByType(changeConfig.org, changeConfig.project, changeConfig.originalType);
        stopProgress(findTimer, `✓ Found ${workItems.length} work items to process`);

        if (workItems.length === 0) {
            console.log('ℹ️  No work items found to change. Exiting.');
            return;
        }

        // Show work items that will be changed
        console.log('\n📋 Work items that will be changed:');
        workItems.forEach((wi, index) => {
            const title = wi.fields['System.Title'] || 'No title';
            const state = wi.fields['System.State'] || 'Unknown';
            const assignedTo = wi.fields['System.AssignedTo']?.displayName || 'Unassigned';
            console.log(`   ${index + 1}. ID: ${wi.id} - ${title} (State: ${state}, Assigned: ${assignedTo})`);
        });

        // Show summary and confirm
        console.log('\n📊 Change Summary:');
        console.log(`Work items to change: ${workItems.length}`);
        console.log(`From type: ${changeConfig.originalType}`);
        console.log(`To type: ${changeConfig.targetType}`);
        console.log(`Mode: ${changeConfig.dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE (changes will be made)'}\n`);

        const { confirm } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirm',
                message: changeConfig.dryRun 
                    ? 'Proceed with dry run?' 
                    : '⚠️  IMPORTANT: This will permanently change work item types. Proceed?',
                default: changeConfig.dryRun
            }
        ]);

        if (!confirm) {
            console.log('❌ Operation cancelled by user.');
            return;
        }

        // Process work items
        console.log(`\n🚀 ${changeConfig.dryRun ? 'Starting dry run' : 'Starting change process'}...\n`);
        
        let successCount = 0;
        let errorCount = 0;
        const errors: Array<{ id: number, title: string, error: string }> = [];

        for (let i = 0; i < workItems.length; i++) {
            const workItem = workItems[i];
            if (!workItem) {
                console.error(`   ❌ Work item at index ${i} is undefined, skipping`);
                errorCount++;
                continue;
            }
            
            const title = workItem.fields['System.Title'] || 'No title';
            const progress = `[${i + 1}/${workItems.length}]`;

            try {
                if (changeConfig.dryRun) {
                    console.log(`📝 ${progress} DRY RUN - Would change: ID ${workItem.id} - ${title}`);
                    console.log(`   FROM: ${changeConfig.originalType} TO: ${changeConfig.targetType}`);
                    successCount++;
                } else {
                    console.log(`📝 ${progress} Changing: ID ${workItem.id} - ${title}`);
                    
                    const updatedWorkItem = await updateWorkItemType(
                        changeConfig.org,
                        changeConfig.project,
                        workItem.id,
                        changeConfig.targetType
                    );

                    console.log(`   ✅ Changed from ${changeConfig.originalType} to ${changeConfig.targetType}`);
                    successCount++;
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`   ❌ Failed to change work item ${workItem.id}: ${errorMessage}`);
                errorCount++;
                errors.push({
                    id: workItem.id,
                    title,
                    error: errorMessage
                });
            }
        }

        // Show final results
        console.log(`\n🎉 ${changeConfig.dryRun ? 'Dry run' : 'Change process'} completed!`);
        console.log(`✅ Successfully processed: ${successCount} work items`);
        
        if (errorCount > 0) {
            console.log(`❌ Failed to process: ${errorCount} work items\n`);
            console.log('❌ Failed work items:');
            errors.forEach(error => {
                console.log(`   ID: ${error.id} - ${error.title}`);
                console.log(`   Error: ${error.error}`);
            });
        }

        // If it was a dry run, ask if user wants to run for real
        if (changeConfig.dryRun && successCount > 0 && errorCount === 0) {
            console.log('\n🎯 Dry run completed successfully with no errors!');
            const { runForReal } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'runForReal',
                    message: 'Do you want to run the actual change process now?',
                    default: false
                }
            ]);

            if (runForReal) {
                console.log('\n🔄 Running actual change process...\n');
                changeConfig.dryRun = false;
                
                // Reset counters
                successCount = 0;
                errorCount = 0;
                errors.length = 0;

                for (let i = 0; i < workItems.length; i++) {
                    const workItem = workItems[i];
                    if (!workItem) {
                        console.error(`   ❌ Work item at index ${i} is undefined, skipping`);
                        errorCount++;
                        continue;
                    }
                    
                    const title = workItem.fields['System.Title'] || 'No title';
                    const progress = `[${i + 1}/${workItems.length}]`;

                    try {
                        console.log(`📝 ${progress} Changing: ID ${workItem.id} - ${title}`);
                        
                        const updatedWorkItem = await updateWorkItemType(
                            changeConfig.org,
                            changeConfig.project,
                            workItem.id,
                            changeConfig.targetType
                        );

                        console.log(`   ✅ Changed from ${changeConfig.originalType} to ${changeConfig.targetType}`);
                        successCount++;
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        console.error(`   ❌ Failed to change work item ${workItem.id}: ${errorMessage}`);
                        errorCount++;
                        errors.push({
                            id: workItem.id,
                            title,
                            error: errorMessage
                        });
                    }
                }

                console.log(`\n🎉 Actual change process completed!`);
                console.log(`✅ Successfully changed: ${successCount} work items`);
                
                if (errorCount > 0) {
                    console.log(`❌ Failed to change: ${errorCount} work items\n`);
                    console.log('❌ Failed work items:');
                    errors.forEach(error => {
                        console.log(`   ID: ${error.id} - ${error.title}`);
                        console.log(`   Error: ${error.error}`);
                    });
                }
            }
        }

    } catch (error) {
        console.error('❌ Error during change process:', error);
        process.exit(1);
    }
}

// Check if this file is being run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    changeWorkItemTypes().catch((err) => {
        console.error('❌ Error:', err);
        process.exit(1);
    });
}

export { changeWorkItemTypes };