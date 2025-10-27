import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from './config.ts';
import { validateAccess } from './auth.ts';
import { listProjects } from './sync-projects.ts';
import inquirer from 'inquirer';
import { writeFileSync, readFileSync } from 'fs';

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

interface IdentityRef {
    displayName: string;
    uniqueName: string;
    id: string;
    descriptor?: string;
}

interface UserEntitlement {
    id: string;
    user: {
        principalName: string;
        displayName: string;
        mailAddress: string;
    };
    accessLevel: {
        accountLicenseType: string;
        licensingSource: string;
    };
}

interface WorkItemType {
    name: string;
    description: string;
    color: string;
    icon: string;
    isDisabled: boolean;
    xmlForm: string;
    fields: WorkItemField[];
    fieldInstances: WorkItemFieldInstance[];
    transitions: { [key: string]: WorkItemStateTransition[] };
    states: WorkItemState[];
}

interface WorkItemField {
    defaultValue: any;
    alwaysRequired: boolean;
    dependentFields: WorkItemFieldDependency[];
    helpText: string;
    allowedValues: string[];
    suggestedValues: string[];
    allowGroups: boolean;
    referenceName: string;
    name: string;
    url: string;
}

interface WorkItemFieldDefinition {
    referenceName: string;
    name: string;
    type: string;
    description: string;
    readOnly: boolean;
    canSortBy: boolean;
    isQueryable: boolean;
    supportedOperations: any[];
    isIdentity: boolean;
    isPicklist: boolean;
    isPicklistSuggested: boolean;
    url: string;
    picklistId?: string;
    usage: string;
}

interface WorkItemFieldInstance {
    field: WorkItemField;
    helpText: string;
    hideWhenNull: boolean;
    id: string;
    name: string;
    alwaysRequired: boolean;
    dependentFields: WorkItemFieldDependency[];
    allowedValues: string[];
    suggestedValues: string[];
    listValues?: string[];
    defaultValue: any;
    allowGroups: boolean;
    referenceName: string;
    url: string;
}

interface WorkItemFieldDependency {
    dependentField: WorkItemField;
    dependentFieldName: string;
    dependentFieldReferenceName: string;
}

interface WorkItemState {
    name: string;
    color: string;
    category: string;
}

interface WorkItemStateTransition {
    to: string;
    actions: string[];
}

interface WorkItemTypeState {
    name: string;
    color: string;
    category: string;
    stateCategory: string;
    order: number;
}

interface WorkItemTypeStateModel {
    states: WorkItemTypeState[];
    transitions: { [stateName: string]: WorkItemStateTransition[] };
}

interface StateReasonMapping {
    state: string;
    reason: string;
}

interface Project {
    id: string;
    name: string;
    description?: string;
    state: string;
}

interface CopyConfig {
    sourceOrg: string;
    sourceProject: string;
    targetOrg: string;
    targetProject: string;
    epicId: number;
    skipMissingTypes: boolean;
    useDefaultValues: boolean;
    userAccessLevel: 'none' | 'stakeholder' | 'basic'; // How to handle missing users
    typeMappings: Map<string, string>; // Map from source type to target type
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

// API Version
const API_VER = '7.1';

// Simple progress indicator
function startProgress(message: string): NodeJS.Timeout {
    process.stdout.write(`${message} `);
    let dots = 0;
    return setInterval(() => {
        process.stdout.write('.');
        dots++;
        if (dots >= 3) {
            process.stdout.write('\b\b\b   \b\b\b');
            dots = 0;
        }
    }, 500);
}

function stopProgress(timer: NodeJS.Timeout, successMessage: string): void {
    clearInterval(timer);
    process.stdout.write(`\r${successMessage}\n`);
}

// Helper function to ensure valid PAT (reuse from sync-projects.ts)
async function ensureValidPAT(org: string): Promise<string> {
    let pat = config.AZDO_PAT;
    
    if (!pat) {
        const answer = await inquirer.prompt([
            {
                type: 'password',
                name: 'pat',
                message: 'Enter your Azure DevOps Personal Access Token (PAT):',
                mask: '*'
            }
        ]);
        pat = answer.pat;
    }

    // Test PAT against the organization
    const AUTH = 'Basic ' + Buffer.from(':' + pat).toString('base64');
    const headers = { Authorization: AUTH };
    
    try {
        const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes`);
        url.searchParams.set('api-version', API_VER);
        const res = await fetch(url, { headers });
        
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                const answer = await inquirer.prompt([
                    {
                        type: 'password',
                        name: 'pat',
                        message: 'Invalid PAT. Enter a valid Azure DevOps Personal Access Token (PAT):',
                        mask: '*'
                    }
                ]);
                pat = answer.pat;
                
                const newAuth = 'Basic ' + Buffer.from(':' + pat).toString('base64');
                const newHeaders = { Authorization: newAuth };
                const newRes = await fetch(url, { headers: newHeaders });
                
                if (!newRes.ok) {
                    throw new Error(`PAT is still invalid for organization ${org}. Status: ${newRes.status}`);
                }
            } else {
                throw new Error(`Error accessing ${org}: ${res.status} ${res.statusText}`);
            }
        }
    } catch (err) {
        if (err instanceof Error && err.message.includes('PAT is still invalid')) {
            throw err;
        }
        throw new Error(`Network error accessing ${org}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Save PAT to config.ts if it was newly provided or changed
    if (pat !== config.AZDO_PAT && pat) {
        try {
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = dirname(__filename);
            const configPath = join(__dirname, 'config.ts');
            let configText = readFileSync(configPath, 'utf-8');
            configText = configText.replace(/AZDO_PAT:\s*['\"][^'\"]*['\"]/, `AZDO_PAT: '${pat}'`);
            writeFileSync(configPath, configText);
            config.AZDO_PAT = pat;
        } catch (err) {
            console.warn('Warning: Could not update config.ts with new PAT:', err);
        }
    }

    return pat;
}

// Get headers with valid PAT
async function getHeaders(org: string): Promise<{ Authorization: string }> {
    const pat = await ensureValidPAT(org);
    const AUTH = 'Basic ' + Buffer.from(':' + pat).toString('base64');
    return { Authorization: AUTH };
}

async function getHeadersJson(org: string): Promise<{ Authorization: string; 'Content-Type': string }> {
    const headers = await getHeaders(org);
    return { ...headers, 'Content-Type': 'application/json' };
}

// Check if user exists in target organization
async function checkUserInOrganization(org: string, userEmail: string): Promise<boolean> {
    try {
        const headers = await getHeaders(org);
        const url = new URL(`https://vsaex.dev.azure.com/${org}/_apis/userentitlements`);
        url.searchParams.set('$filter', `user/mailAddress eq '${userEmail}'`);
        url.searchParams.set('api-version', '7.1-preview.3');

        const res = await fetch(url, { headers });
        if (!res.ok) {
            console.warn(`Warning: Could not check user ${userEmail} in org ${org}: ${res.statusText}`);
            return false;
        }

        const body = await res.json();
        return body.count > 0;
    } catch (error) {
        console.warn(`Warning: Error checking user ${userEmail} in org ${org}:`, error);
        return false;
    }
}

// Add user to target organization
async function addUser(org: string, userEmail: string, displayName: string, accountLicenseType: string = "stakeholder"): Promise<boolean> {
    try {
        const headers = await getHeadersJson(org);
        const url = new URL(`https://vsaex.dev.azure.com/${org}/_apis/userentitlements`);
        url.searchParams.set('api-version', '7.1-preview.3');

        const payload = {
            accessLevel: {
                accountLicenseType: accountLicenseType || "stakeholder"
            },
            user: {
                principalName: userEmail,
                subjectKind: "user"
            }
        };

        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            const responseBody = await res.json();
            
            // Check if the response indicates success
            if (responseBody.isSuccess === false || responseBody.operationResult?.isSuccess === false) {
                const errors = responseBody.operationResult?.errors || responseBody.errors || [];
                const errorMessages = errors.map((err: any) => err.value || err.message || err).join(', ');
                console.warn(`   ⚠️  Could not add ${displayName} (${userEmail}) as a ${accountLicenseType} user: ${errorMessages}`);
                return false;
            }

            console.log(`   ✅ Added ${displayName} (${userEmail}) as a ${accountLicenseType} user to ${org}`);
            return true;
        } else {
            const errorText = await res.text();
            console.warn(`   ⚠️  Could not add ${displayName} (${userEmail}) as a ${accountLicenseType} user: ${res.status} ${errorText}`);
            return false;
        }
    } catch (error) {
        console.warn(`   ⚠️  Error adding ${displayName} (${userEmail}) as a ${accountLicenseType} user:`, error);
        return false;
    }
}

// Extract identity information from field value
function extractIdentityInfo(fieldValue: any): IdentityRef | null {
    if (!fieldValue) return null;
    
    // Handle different identity field formats
    if (typeof fieldValue === 'string') {
        // Simple string format: "Display Name <email@domain.com>"
        const match = fieldValue.match(/^(.+?)\s*<(.+?)>$/);
        if (match && match[1] && match[2]) {
            return {
                displayName: match[1].trim(),
                uniqueName: match[2].trim(),
                id: ''
            };
        }
        // Just email
        if (fieldValue.includes('@')) {
            return {
                displayName: fieldValue,
                uniqueName: fieldValue,
                id: ''
            };
        }
    } else if (typeof fieldValue === 'object') {
        // Object format with displayName and uniqueName properties
        if (fieldValue.displayName && fieldValue.uniqueName) {
            return {
                displayName: fieldValue.displayName,
                uniqueName: fieldValue.uniqueName,
                id: fieldValue.id || ''
            };
        }
    }
    
    return null;
}


// Process identity fields and manage user access
async function processIdentityFields(
    fields: { [key: string]: any },
    targetOrg: string,
    addMissingUsers: boolean,
    fieldDefinitions: WorkItemFieldDefinition[],
    userAccessLevel: 'none' | 'stakeholder' | 'basic' = 'none'
): Promise<{ [key: string]: any }> {
    const processedFields = { ...fields };
    
    // Find all identity fields dynamically using field definitions
    const identityFieldRefs = fieldDefinitions
        .filter(f => f.isIdentity)
        .map(f => f.referenceName);
    
    // Fallback to known identity fields if field definitions are not available
    const fallbackIdentityFields = ['System.AssignedTo', 'System.CreatedBy', 'System.ChangedBy', 'Microsoft.VSTS.Common.ClosedBy'];
    const identityFields = identityFieldRefs.length > 0 ? identityFieldRefs : fallbackIdentityFields;
    
    console.log(`   🔍 Processing ${identityFields.length} identity fields: [${identityFields.join(', ')}]`);
    
    for (const fieldName of identityFields) {
        if (!fields[fieldName]) continue;
        
        const identity = extractIdentityInfo(fields[fieldName]);
        if (!identity || !identity.uniqueName.includes('@')) continue;
        
        console.log(`   🔍 Checking user access: ${identity.displayName} (${identity.uniqueName})`);
        
        const userExists = await checkUserInOrganization(targetOrg, identity.uniqueName);
        
        if (!userExists) {
            console.log(`   ⚠️  User ${identity.displayName} not found in ${targetOrg}`);
            
            if (addMissingUsers && userAccessLevel !== 'none') {
                const added = await addUser(targetOrg, identity.uniqueName, identity.displayName, userAccessLevel);
                if (!added) {
                    // Remove the identity field if we couldn't add the user
                    console.log(`   🔄 Removing identity field ${fieldName} due to access issues`);
                    delete processedFields[fieldName];
                }
            } else {
                // Remove the identity field if user doesn't want to add missing users
                console.log(`   🔄 Removing identity field ${fieldName} - user not in target org`);
                delete processedFields[fieldName];
            }
        } else {
            console.log(`   ✅ User ${identity.displayName} has access to ${targetOrg}`);
        }
    }
    
    return processedFields;
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

// Get all work item field definitions
async function getWorkItemFields(org: string, project: string): Promise<WorkItemFieldDefinition[]> {
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/${project}/_apis/wit/fields`);
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Get work item fields (${org}/${project}): ${res.statusText}`);

    const body = await res.json();
    return body.value;
}

// Get picklist values for a field
async function getPicklistValues(org: string, picklistId: string): Promise<string[]> {
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes/lists/${picklistId}`);
    url.searchParams.set('api-version', API_VER);

    try {
        const res = await fetch(url, { headers });
        if (!res.ok) {
            console.warn(`Warning: Could not fetch picklist values for ${picklistId}: ${res.statusText}`);
            return [];
        }

        const body = await res.json();
        return body.items ? body.items.map((item: any) => item.value || item) : [];
    } catch (error) {
        console.warn(`Warning: Error fetching picklist values for ${picklistId}:`, error);
        return [];
    }
}

// Get detailed work item type with field instances
async function getWorkItemTypeDetails(org: string, project: string, workItemTypeName: string): Promise<WorkItemType> {
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/${project}/_apis/wit/workitemtypes/${encodeURIComponent(workItemTypeName)}`);
    url.searchParams.set('$expand', 'fields');
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Get work item type details (${org}/${project}/${workItemTypeName}): ${res.statusText}`);

    return res.json();
}

// Get work item type states and transitions
async function getWorkItemTypeStates(org: string, project: string, workItemTypeName: string): Promise<WorkItemTypeStateModel> {
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/${project}/_apis/wit/workitemtypes/${encodeURIComponent(workItemTypeName)}/states`);
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Get work item type states (${org}/${project}/${workItemTypeName}): ${res.statusText}`);

    const body = await res.json();
    return {
        states: body.value || [],
        transitions: body.transitions || {}
    };
}

// Get valid state reason for a given state in a work item type
function getValidStateReason(stateModel: WorkItemTypeStateModel, targetState: string): string {
    // Find the target state in the states array
    const state = stateModel.states.find(s => s.name === targetState);
    
    if (!state) {
        console.warn(`State "${targetState}" not found in work item type states`);
        return 'New'; // Default fallback
    }

    // For initial state creation, we typically want the default reason for that state
    // Common state reasons mapping based on Azure DevOps patterns
    const stateReasonMap: { [key: string]: string } = {
        'New': 'New',
        'Active': 'New',
        'Proposed': 'New',
        'In Progress': 'Moved to In Progress',
        'Committed': 'Committed',
        'Done': 'Completed',
        'Completed': 'Completed',
        'Closed': 'Completed',
        'Resolved': 'Fixed',
        'Removed': 'Removed from the backlog'
    };

    return stateReasonMap[targetState] || 'New';
}

// Get work item by ID with full details
async function getWorkItem(org: string, project: string, id: number): Promise<WorkItem> {
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/${project}/_apis/wit/workitems/${id}`);
    url.searchParams.set('$expand', 'relations');
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Get work item ${id} (${org}/${project}): ${res.statusText}`);

    return res.json();
}

// Execute WIQL query
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

// Get Epic and all its child work items using WIQL query for better performance
async function getEpicAndChildrenOptimized(org: string, project: string, epicId: number): Promise<{ epic: WorkItem, children: WorkItem[] }> {
    // WIQL query to get the Epic and all its descendant work items
    // This query finds all work items that are linked to the Epic in a hierarchical relationship
    const wiql = `
        SELECT [System.Id]
        FROM WorkItemLinks
        WHERE (
            [Source].[System.Id] = ${epicId}
        )
        AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'
        MODE (Recursive)
    `;

    try {
        // Execute the query
        const queryResult = await executeWiqlQuery(org, project, wiql);
        
        // Extract all unique work item IDs
        const workItemIds = new Set<number>();
        
        // Add the epic ID first
        workItemIds.add(epicId);
        
        // Add work items from relations (targets are the children)
        if (queryResult.workItemRelations) {
            queryResult.workItemRelations.forEach(relation => {
                if (relation.target) workItemIds.add(relation.target.id);
            });
        }
        
        // Fetch all work items in batch
        const allWorkItems = await getWorkItemsBatch(org, project, Array.from(workItemIds));
        
        // Find the epic and separate children
        const epic = allWorkItems.find(wi => wi.id === epicId);
        if (!epic) {
            throw new Error(`Epic with ID ${epicId} not found`);
        }
        
        const children = allWorkItems.filter(wi => wi.id !== epicId);
        
        return { epic, children };
        
    } catch (error) {
        console.warn(`   ⚠️  WIQL query failed, falling back to recursive method: ${error}`);
        
        // Fallback to the old recursive method if WIQL fails
        const epic = await getWorkItem(org, project, epicId);
        const children = await getChildWorkItems(org, project, epicId);
        
        return { epic, children };
    }
}

// Get child work items recursively (DEPRECATED - use getEpicAndChildrenOptimized for better performance)
async function getChildWorkItems(org: string, project: string, parentId: number): Promise<WorkItem[]> {
    const parent = await getWorkItem(org, project, parentId);
    const children: WorkItem[] = [];

    if (parent.relations) {
        for (const relation of parent.relations) {
            if (relation.rel === 'System.LinkTypes.Hierarchy-Forward') {
                // Extract work item ID from URL
                const match = relation.url.match(/workItems\/(\d+)$/);
                if (match && match[1]) {
                    const childId = parseInt(match[1]);
                    const child = await getWorkItem(org, project, childId);
                    children.push(child);
                    
                    // Recursively get grandchildren
                    const grandchildren = await getChildWorkItems(org, project, childId);
                    children.push(...grandchildren);
                }
            }
        }
    }

    return children;
}

// Create work item in target project
async function createWorkItem(org: string, project: string, workItemType: string, fields: { [key: string]: any }, includeStateFields: boolean = false): Promise<WorkItem> {
    const headers = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/${project}/_apis/wit/workitems/$${workItemType}`);
    url.searchParams.set('api-version', API_VER);

    // Convert fields to patch format, filtering out null/undefined values
    // Conditionally exclude System.State and System.Reason based on includeStateFields parameter
    const patchDocument = Object.entries(fields)
        .filter(([field, value]) => 
            value !== null && 
            value !== undefined && 
            value !== '' &&
            (includeStateFields || (field !== 'System.State' && field !== 'System.Reason'))
        )
        .map(([field, value]) => ({
            op: 'add',
            path: `/fields/${field}`,
            value: value
        }));

    // Debug: Log the fields being sent
    // console.log(`   📋 Fields to create (${patchDocument.length} fields):`, 
    //     patchDocument.map(p => `${p.path}: ${JSON.stringify(p.value).substring(0, 50)}${JSON.stringify(p.value).length > 50 ? '...' : ''}`));

    const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify(patchDocument)
    });

    if (!res.ok) {
        const errorText = await res.text();
        console.error(`   🔍 Failed request details:`);
        console.error(`   URL: ${url.toString()}`);
        console.error(`   Fields sent:`, JSON.stringify(patchDocument, null, 2));
        throw new Error(`Create work item failed (${org}/${project}): ${res.status} ${errorText}`);
    }

    return res.json();
}

// Update work item state and reason
async function updateWorkItemState(org: string, project: string, workItemId: number, state: string, reason: string): Promise<void> {
    const headers = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/${project}/_apis/wit/workitems/${workItemId}`);
    url.searchParams.set('api-version', API_VER);

    const patchDocument = [
        {
            op: 'add',
            path: '/fields/System.State',
            value: state
        },
        // {
        //     op: 'add', 
        //     path: '/fields/System.Reason',
        //     value: reason
        // }
    ];

    const res = await fetch(url, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify(patchDocument)
    });

    if (!res.ok) {
        const errorText = await res.text();
        console.warn(`   ⚠️  Failed to update state to "${state}" with reason "${reason}": ${res.status} ${errorText}`);
        throw new Error(`Update work item state failed (${org}/${project}/${workItemId}): ${res.status} ${errorText}`);
    }
}

// Add child link between work items
async function addChildLink(org: string, project: string, parentId: number, childId: number): Promise<void> {
    const headers = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/${project}/_apis/wit/workitems/${parentId}`);
    url.searchParams.set('api-version', API_VER);

    const patchDocument = [{
        op: 'add',
        path: '/relations/-',
        value: {
            rel: 'System.LinkTypes.Hierarchy-Forward',
            url: `https://dev.azure.com/${org}/${project}/_apis/wit/workItems/${childId}`,
            attributes: {
                comment: 'Copied from source organization'
            }
        }
    }];

    const res = await fetch(url, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify(patchDocument)
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Add child link failed (${org}/${project}): ${res.status} ${errorText}`);
    }
}

// Get default values for missing required fields
function getDefaultValue(field: WorkItemFieldInstance, fieldDefinitions: WorkItemFieldDefinition[]): any {
    const fieldType = field.field?.referenceName || field.referenceName || '';
    const fieldName = (field.name || '').toLowerCase();
    const fieldRef = field.referenceName || field.field?.referenceName || '';

    // Check if this is an identity field using the field definitions
    const fieldDef = fieldDefinitions.find(f => f.referenceName === fieldRef);
    if (fieldDef && fieldDef.isIdentity) {
        return null; // Don't set identity fields with defaults
    }

    // Handle specific field types based on common Azure DevOps field patterns
    if (fieldType.includes('String') || fieldType.includes('PlainText')) {
        return 'TBD';
    } else if (fieldType.includes('HTML')) {
        return '<div>TBD</div>';
    } else if (fieldType.includes('Integer')) {
        return 0;
    } else if (fieldType.includes('Double') || fieldType.includes('Decimal')) {
        return 0.0;
    } else if (fieldType.includes('DateTime')) {
        return new Date().toISOString();
    } else if (fieldType.includes('Boolean')) {
        return false;
    } else if (fieldType.includes('Identity')) {
        return null; // Don't set identity fields with defaults (fallback check)
    } else if (field.allowedValues && field.allowedValues.length > 0) {
        return field.allowedValues[0];
    } else if (field.listValues && field.listValues.length > 0) {
        return field.listValues[0];
    } else if (field.defaultValue !== null && field.defaultValue !== undefined) {
        return field.defaultValue;
    }

    // Field-specific defaults based on common Azure DevOps fields
    if (fieldName.includes('priority')) {
        return 2; // Medium priority
    } else if (fieldName.includes('state')) {
        return 'New'; // Default state
    } else if (fieldName.includes('reason')) {
        return 'New'; // Default reason
    } else if (fieldName.includes('severity')) {
        return '3 - Medium';
    } else if (fieldName.includes('activity')) {
        return 'Development';
    }

    return 'TBD';
}

// Validate and sanitize field value based on field constraints
async function validateFieldValue(
    fieldRef: string, 
    sourceValue: any, 
    targetWorkItemType: WorkItemType, 
    fieldDefinitions: WorkItemFieldDefinition[],
    org: string
): Promise<any> {
    // Find the field definition to get comprehensive field information
    const fieldDef = fieldDefinitions.find(f => f.referenceName === fieldRef);
    
    // Check if this is an identity field using the isIdentity property
    if (fieldDef && fieldDef.isIdentity) {
        console.log(`   🔍 Field "${fieldRef}": is identity field, will be processed separately`);
        return sourceValue; // Identity fields are processed in processIdentityFields
    }
    
    // Find the field in the target work item type to get the actual allowed values
    let targetField: WorkItemFieldInstance | undefined;
    
    // Look in fieldInstances first (more detailed)
    if (targetWorkItemType.fieldInstances) {
        targetField = targetWorkItemType.fieldInstances.find(f => 
            f.referenceName === fieldRef || f.field?.referenceName === fieldRef
        );
    }
    
    // Fallback to fields array
    if (!targetField && targetWorkItemType.fields) {
        const fieldDefFromType = targetWorkItemType.fields.find(f => f.referenceName === fieldRef);
        if (fieldDefFromType) {
            targetField = {
                field: fieldDefFromType,
                referenceName: fieldRef,
                name: fieldDefFromType.name,
                allowedValues: fieldDefFromType.allowedValues || [],
                listValues: fieldDefFromType.suggestedValues || [],
                defaultValue: fieldDefFromType.defaultValue,
                alwaysRequired: fieldDefFromType.alwaysRequired,
                dependentFields: fieldDefFromType.dependentFields || [],
                helpText: fieldDefFromType.helpText || '',
                hideWhenNull: false,
                id: fieldRef,
                suggestedValues: fieldDefFromType.suggestedValues || [],
                allowGroups: fieldDefFromType.allowGroups || false,
                url: fieldDefFromType.url || ''
            };
        }
    }
    
    if (!targetField) {
        console.log(`   ⚠️  Field "${fieldRef}" not found in target work item type, using source value`);
        return sourceValue;
    }

    // Check for picklist values if this is a picklist field
    let allowedValues: string[] = [];
    
    if (fieldDef && fieldDef.isPicklist && fieldDef.picklistId) {
        console.log(`   🔍 Field "${fieldRef}": is picklist field (ID: ${fieldDef.picklistId}), fetching picklist values...`);
        try {
            allowedValues = await getPicklistValues(org, fieldDef.picklistId);
            console.log(`   ✓ Found ${allowedValues.length} picklist values for "${fieldRef}"`);
        } catch (error) {
            console.warn(`   ⚠️  Could not fetch picklist values for field "${fieldRef}":`, error);
        }
    }
    
    // Fallback to field instance allowed/suggested values
    if (allowedValues.length === 0) {
        allowedValues = targetField.allowedValues && targetField.allowedValues.length > 0 
            ? targetField.allowedValues 
            : targetField.listValues && targetField.listValues.length > 0 
            ? targetField.listValues 
            : targetField.field?.allowedValues && targetField.field.allowedValues.length > 0
            ? targetField.field.allowedValues
            : targetField.field?.suggestedValues && targetField.field.suggestedValues.length > 0
            ? targetField.field.suggestedValues
            : [];
    }

    // If the field has allowed/list values, check if source value is permitted
    if (allowedValues.length > 0) {
        // Debug logging
        console.log(`   🔍 Field "${fieldRef}": checking value "${sourceValue}" against allowed values [${allowedValues.join(', ')}]`);
        
        // Check if source value is in allowed values (case-insensitive for strings)
        const isAllowed = allowedValues.some(allowed => {
            if (typeof sourceValue === 'string' && typeof allowed === 'string') {
                return sourceValue.toLowerCase() === allowed.toLowerCase();
            }
            return sourceValue === allowed;
        });
        
        if (!isAllowed) {
            const valueType = fieldDef && fieldDef.isPicklist ? 'picklist' : 'allowed';
            console.log(`   ⚠️  Field "${fieldRef}": value "${sourceValue}" not in ${valueType} values [${allowedValues.join(', ')}], using default`);
            
            // Return the first allowed/list value or a field-specific default
            if (fieldRef === 'Microsoft.VSTS.Common.Priority') {
                // For priority, use 2 (Medium) if it's in allowed values, otherwise first value
                const mediumPriority = allowedValues.find(v => 
                    (typeof v === 'number' && v === 2) || 
                    (typeof v === 'string' && v === '2')
                );
                return mediumPriority || allowedValues[0];
            } else if (fieldRef === 'Microsoft.VSTS.Common.Severity') {
                // For severity, prefer "3 - Medium" or similar
                const mediumSeverity = allowedValues.find(v => 
                    typeof v === 'string' && v.toLowerCase().includes('medium')
                );
                return mediumSeverity || allowedValues[0];
            } else if (fieldRef === 'Microsoft.VSTS.Common.Activity') {
                // For activity, prefer "Development" or similar
                const developmentActivity = allowedValues.find(v => 
                    typeof v === 'string' && v.toLowerCase().includes('development')
                );
                return developmentActivity || allowedValues[0];
            } else {
                return allowedValues[0];
            }
        } else {
            console.log(`   ✅ Field "${fieldRef}": value "${sourceValue}" is valid`);
        }
    }
    
    // For specific known fields with numeric constraints
    if (fieldRef === 'Microsoft.VSTS.Common.Priority') {
        const numValue = parseInt(sourceValue);
        if (isNaN(numValue) || numValue < 1 || numValue > 4) {
            console.log(`   ⚠️  Field "${fieldRef}": value "${sourceValue}" not in range 1-4, using default 2`);
            return 2;
        }
    } else if (fieldRef === 'Microsoft.VSTS.Common.StackRank') {
        // Stack rank should be a positive number
        const numValue = parseFloat(sourceValue);
        if (isNaN(numValue) || numValue < 0) {
            console.log(`   ⚠️  Field "${fieldRef}": invalid value "${sourceValue}", using default 0`);
            return 0;
        }
    } else if (fieldRef.includes('Effort') || fieldRef.includes('StoryPoints')) {
        // Effort and story points should be non-negative numbers
        const numValue = parseFloat(sourceValue);
        if (isNaN(numValue) || numValue < 0) {
            console.log(`   ⚠️  Field "${fieldRef}": invalid value "${sourceValue}", using default 0`);
            return 0;
        }
    }
    
    // Validate date fields
    if (fieldRef.includes('Date') || fieldRef.includes('DateTime')) {
        if (typeof sourceValue === 'string') {
            const dateValue = new Date(sourceValue);
            if (isNaN(dateValue.getTime())) {
                console.log(`   ⚠️  Field "${fieldRef}": invalid date "${sourceValue}", using current date`);
                return new Date().toISOString();
            }
        }
    }
    
    // Validate boolean fields
    const fieldType = targetField.field?.referenceName || targetField.referenceName || '';
    if (fieldType.includes('Boolean')) {
        if (typeof sourceValue !== 'boolean') {
            const boolValue = sourceValue === 'true' || sourceValue === '1' || sourceValue === 1;
            console.log(`   ⚠️  Field "${fieldRef}": converting "${sourceValue}" to boolean ${boolValue}`);
            return boolValue;
        }
    }
    
    // Value is valid, return as-is
    return sourceValue;
}

// Map source fields to target fields
async function mapWorkItemFields(
    sourceWorkItem: WorkItem,
    targetType: WorkItemType,
    useDefaults: boolean,
    fieldDefinitions: WorkItemFieldDefinition[],
    org: string,
    stateModel?: WorkItemTypeStateModel
): Promise<{ fields: { [key: string]: any }, state?: string, reason?: string, includeStateInCreation?: boolean }> {
    const mappedFields: { [key: string]: any } = {};
    const sourceFields = sourceWorkItem.fields;
    let targetState: string | undefined;
    let targetReason: string | undefined;
    let includeStateInCreation = false;

    // Always copy basic fields that should exist in all work item types
    const basicFields = ['System.Title', 'System.Description', 'System.Tags'];
    
    for (const basicField of basicFields) {
        if (sourceFields[basicField] && sourceFields[basicField] !== null && sourceFields[basicField] !== '') {
            mappedFields[basicField] = sourceFields[basicField];
        }
    }

    // Ensure we have a title (required field)
    if (!mappedFields['System.Title']) {
        mappedFields['System.Title'] = 'Copied Work Item';
    }

    // Map other fields that exist in both source and target
    const fieldInstances = targetType.fieldInstances || targetType.fields || [];
    
    for (const targetField of fieldInstances) {
        const fieldRef = targetField.referenceName || targetField.field?.referenceName;
        
        if (!fieldRef) continue; // Skip if we can't determine the field reference
        
        // Skip system fields that shouldn't be copied or are read-only
        if (fieldRef.startsWith('System.Id') || 
            fieldRef.startsWith('System.Rev') ||
            fieldRef.startsWith('System.CreatedDate') ||
            fieldRef.startsWith('System.CreatedBy') ||
            fieldRef.startsWith('System.ChangedDate') ||
            fieldRef.startsWith('System.ChangedBy') ||
            fieldRef.startsWith('System.AuthorizedDate') ||
            fieldRef.startsWith('System.RevisedDate') ||
            fieldRef.startsWith('System.Watermark') ||
            fieldRef.startsWith('System.BoardColumn') ||
            fieldRef.startsWith('System.BoardLane') ||
            fieldRef === 'System.TeamProject' ||
            fieldRef === 'System.AreaId' ||
            fieldRef === 'System.NodeName' ||
            fieldRef === 'System.AreaLevel1' ||
            fieldRef === 'System.IterationId' ||
            fieldRef === 'System.IterationLevel1' ||
            fieldRef === 'System.AreaPath' ||
            fieldRef === 'System.CommentCount' ||
            fieldRef === 'System.IterationPath' ||
            fieldRef === 'Microsoft.VSTS.Common.StateChangeDate' ||
            fieldRef === 'Microsoft.VSTS.Common.StackRank' ||
            fieldRef === 'Microsoft.VSTS.Common.ActivatedBy' ||
            fieldRef === 'Microsoft.VSTS.Common.ActivatedDate' ||
            fieldRef === 'Microsoft.VSTS.Common.ResolvedDate' ||
            fieldRef === 'Microsoft.VSTS.Common.ResolvedBy' ||
            fieldRef === 'Microsoft.VSTS.Common.ClosedDate' ||
            fieldRef === 'Microsoft.VSTS.Common.ClosedBy') {
            continue;
        }

        // Skip if already mapped in basic fields
        if (basicFields.includes(fieldRef)) {
            continue;
        }

        // If source has this field and it's not null/empty, copy it
        if (sourceFields[fieldRef] !== null && 
            sourceFields[fieldRef] !== undefined && 
            sourceFields[fieldRef] !== '') {
            
            // Special handling for state and reason fields
            if (fieldRef === 'System.State' && stateModel) {
                const sourceState = sourceFields[fieldRef];
                // Check if the source state exists in target work item type
                const validState = stateModel.states.find(s => s.name === sourceState);
                if (validState) {
                    targetState = sourceState;
                    targetReason = getValidStateReason(stateModel, sourceState);
                    
                    // Check if state category is "Proposed" - if so, include in creation
                    if (validState.stateCategory === 'Proposed') {
                        includeStateInCreation = true;
                        mappedFields[fieldRef] = sourceState;
                        mappedFields['System.Reason'] = targetReason;
                        console.log(`   📝 Including state "${sourceState}" in creation (Proposed category)`);
                    } else {
                        console.log(`   🔄 Will update state "${sourceState}" after creation (${validState.stateCategory} category)`);
                    }
                } else {
                    // Use the first state (typically "New") if source state doesn't exist in target
                    const defaultState = stateModel.states[0]?.name || 'New';
                    const defaultStateObj = stateModel.states[0];
                    targetState = defaultState;
                    targetReason = getValidStateReason(stateModel, defaultState);
                    
                    // Check if default state category is "Proposed"
                    if (defaultStateObj?.stateCategory === 'Proposed') {
                        includeStateInCreation = true;
                        mappedFields[fieldRef] = defaultState;
                        mappedFields['System.Reason'] = targetReason;
                        console.log(`   📝 Including default state "${defaultState}" in creation (Proposed category)`);
                    }
                    console.log(`   ⚠️  State "${sourceState}" not valid in target, using "${defaultState}"`);
                }
            } else if (fieldRef === 'System.Reason') {
                // Skip System.Reason here as it's handled with System.State
                continue;
            } else {
                // Validate and sanitize the field value based on target field constraints
                const validatedValue = await validateFieldValue(fieldRef, sourceFields[fieldRef], targetType, fieldDefinitions, org);
                mappedFields[fieldRef] = validatedValue;
            }
        } else if (targetField.alwaysRequired && useDefaults) {
            // If it's required in target but not present in source, use default
            try {
                if (fieldRef === 'System.State' && stateModel) {
                    const defaultState = stateModel.states[0]?.name || 'New';
                    const defaultStateObj = stateModel.states[0];
                    targetState = defaultState;
                    targetReason = getValidStateReason(stateModel, defaultState);
                    
                    // Check if default state category is "Proposed"
                    if (defaultStateObj?.stateCategory === 'Proposed') {
                        includeStateInCreation = true;
                        mappedFields[fieldRef] = defaultState;
                        mappedFields['System.Reason'] = targetReason;
                        console.log(`   📝 Including required default state "${defaultState}" in creation (Proposed category)`);
                    }
                } else if (fieldRef === 'System.Reason') {
                    // Skip System.Reason here as it's handled with System.State
                    continue;
                } else {
                    const defaultValue = getDefaultValue(targetField, fieldDefinitions);
                    if (defaultValue !== null) {
                        mappedFields[fieldRef] = defaultValue;
                    }
                }
            } catch (error) {
                console.warn(`Warning: Could not get default value for field ${fieldRef}:`, error);
            }
        }
    }
    
    // If we have a state model but no state was set yet, check if we should set a default
    if (stateModel && !targetState && stateModel.states.length > 0) {
        const sourceState = sourceFields['System.State'];
        if (sourceState) {
            // Source has a state but it wasn't processed above (probably not in the field instances)
            const validState = stateModel.states.find(s => s.name === sourceState);
            if (validState) {
                targetState = sourceState;
                targetReason = getValidStateReason(stateModel, sourceState);
                
                // Check if state category is "Proposed"
                if (validState.stateCategory === 'Proposed') {
                    includeStateInCreation = true;
                    mappedFields['System.State'] = sourceState;
                    mappedFields['System.Reason'] = targetReason;
                }
            } else {
                const defaultState = stateModel.states[0]?.name || 'New';
                const defaultStateObj = stateModel.states[0];
                targetState = defaultState;
                targetReason = getValidStateReason(stateModel, defaultState);
                
                // Check if default state category is "Proposed"
                if (defaultStateObj?.stateCategory === 'Proposed') {
                    includeStateInCreation = true;
                    mappedFields['System.State'] = defaultState;
                    mappedFields['System.Reason'] = targetReason;
                }
                console.log(`   ⚠️  State "${sourceState}" not valid in target, using "${defaultState}"`);
            }
        }
    }

    const result: { fields: { [key: string]: any }, state?: string, reason?: string, includeStateInCreation?: boolean } = {
        fields: mappedFields
    };
    
    if (targetState && targetReason) {
        result.state = targetState;
        result.reason = targetReason;
        result.includeStateInCreation = includeStateInCreation;
    }
    
    return result;
}

// Interactive configuration
async function getCopyConfig(): Promise<CopyConfig> {
    // Validate access first
    console.log('Validating access to organizations...');
    const sourceOrg = config.organizations[0] || 'STMN-Group';
    const targetOrg = config.organizations[1] || 'STMN-Group-DEV';
    const accessResult = await validateAccess(sourceOrg, targetOrg);
    if (!accessResult.hasAccess) {
        console.error('❌ Access Error:', accessResult.error);
        process.exit(1);
    }
    console.log('✓ Access validated successfully\n');

    // Get organization and project selection
    const answers = await inquirer.prompt([
        {
            type: 'list',
            name: 'sourceOrg',
            message: 'Select the source organization:',
            choices: config.organizations
        },
        {
            type: 'list',
            name: 'targetOrg',
            message: 'Select the target organization:',
            choices: config.organizations
        }
    ]);

    // Get projects for source org
    console.log(`\nFetching projects from ${answers.sourceOrg}...`);
    const sourceProjects = await listProjects(answers.sourceOrg);
    const sourceProjectChoices = sourceProjects
        .map(p => ({ name: p.name, value: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name));

    console.log(`Fetching projects from ${answers.targetOrg}...`);
    const targetProjects = await listProjects(answers.targetOrg);
    const targetProjectChoices = targetProjects
        .map(p => ({ name: p.name, value: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const projectAnswers = await inquirer.prompt([
        {
            type: 'list',
            name: 'sourceProject',
            message: 'Select the source project:',
            choices: sourceProjectChoices
        },
        {
            type: 'list',
            name: 'targetProject',
            message: 'Select the target project:',
            choices: targetProjectChoices
        },
        {
            type: 'number',
            name: 'epicId',
            message: 'Enter the Epic ID to copy (with all its children):',
            validate: (input) => {
                const num = parseInt(input);
                return !isNaN(num) && num > 0 ? true : 'Please enter a valid Epic ID';
            }
        }
    ]);

    return {
        sourceOrg: answers.sourceOrg,
        sourceProject: projectAnswers.sourceProject,
        targetOrg: answers.targetOrg,
        targetProject: projectAnswers.targetProject,
        epicId: projectAnswers.epicId,
        skipMissingTypes: false,
        useDefaultValues: false,
        userAccessLevel: 'none' as const,
        typeMappings: new Map<string, string>()
    };
}

// Main copy function
async function copyEpicAndChildren(): Promise<void> {
    try {
        const copyConfig = await getCopyConfig();

        console.log('\n📋 Copy Configuration:');
        console.log(`Source: ${copyConfig.sourceOrg}/${copyConfig.sourceProject}`);
        console.log(`Target: ${copyConfig.targetOrg}/${copyConfig.targetProject}`);
        console.log(`Epic ID: ${copyConfig.epicId}\n`);

        // Get Epic and all its children using optimized WIQL query
        const epicTimer = startProgress('🔍 Fetching Epic and child work items');
        const { epic, children } = await getEpicAndChildrenOptimized(copyConfig.sourceOrg, copyConfig.sourceProject, copyConfig.epicId);
        stopProgress(epicTimer, `✓ Found ${1 + children.length} work items to copy (1 Epic + ${children.length} children)`);
        
        const allWorkItems = [epic, ...children];
        console.log('');

        // Get work item types from both projects
        const typesTimer = startProgress('🔍 Checking work item types');
        const sourceTypes = await getWorkItemTypes(copyConfig.sourceOrg, copyConfig.sourceProject);
        const targetTypes = await getWorkItemTypes(copyConfig.targetOrg, copyConfig.targetProject);
        stopProgress(typesTimer, `✓ Found ${sourceTypes.length} source types and ${targetTypes.length} target types`);
        
        const sourceTypeNames = new Set(sourceTypes.map(t => t.name));
        const targetTypeNames = new Set(targetTypes.map(t => t.name));

        // Check for missing work item types
        const workItemTypes = allWorkItems.map(wi => wi.fields['System.WorkItemType']);
        const uniqueTypes = [...new Set(workItemTypes)];
        const missingTypes = uniqueTypes.filter(type => !targetTypeNames.has(type));

        if (missingTypes.length > 0) {
            console.log(`⚠️  Missing work item types in target project: ${missingTypes.join(', ')}`);
            
            // For each missing type, ask what to do
            for (const missingType of missingTypes) {
                const workItemsOfThisType = allWorkItems.filter(wi => wi.fields['System.WorkItemType'] === missingType);
                console.log(`\n📋 Found ${workItemsOfThisType.length} work items of type "${missingType}":`);
                workItemsOfThisType.forEach((wi, index) => {
                    const title = wi.fields['System.Title'] || 'No title';
                    console.log(`   ${index + 1}. ID: ${wi.id} - ${title}`);
                });

                const { action } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'action',
                        message: `What would you like to do with work items of type "${missingType}"?`,
                        choices: [
                            { name: 'Skip these work items', value: 'skip' },
                            { name: 'Migrate to another work item type', value: 'migrate' }
                        ],
                        default: 'skip'
                    }
                ]);

                if (action === 'migrate') {
                    // Show available target types for migration
                    const targetTypeChoices = targetTypes
                        .filter(t => !t.isDisabled)
                        .map(t => ({ 
                            name: `${t.name} - ${t.description || 'No description'}`, 
                            value: t.name 
                        }))
                        .sort((a, b) => a.value.localeCompare(b.value));

                    const { targetType } = await inquirer.prompt([
                        {
                            type: 'list',
                            name: 'targetType',
                            message: `Select target work item type to migrate "${missingType}" to:`,
                            choices: targetTypeChoices
                        }
                    ]);

                    console.log(`✅ Will migrate "${missingType}" to "${targetType}"`);
                    copyConfig.typeMappings.set(missingType, targetType);
                } else {
                    console.log(`⏭️  Will skip work items of type "${missingType}"`);
                    copyConfig.skipMissingTypes = true;
                }
            }

            // If user chose to skip all missing types and no mappings were created
            if (copyConfig.skipMissingTypes && copyConfig.typeMappings.size === 0) {
                console.log('⏭️  All missing types will be skipped');
            } else if (copyConfig.typeMappings.size > 0) {
                console.log('\n📋 Type mappings created:');
                copyConfig.typeMappings.forEach((targetType, sourceType) => {
                    console.log(`   ${sourceType} → ${targetType}`);
                });
            }
        }

        // Check for required fields and ask about defaults
        console.log('🔍 Checking required fields...');
        const fieldPrompts = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'useDefaults',
                message: 'Use default values for missing required fields? (TBD for text, 0 for numbers, etc.)',
                default: true
            },
            {
                type: 'list',
                name: 'userAccessLevel',
                message: 'How should missing users be handled in the target organization?',
                choices: [
                    { name: 'Do not add users (remove identity fields)', value: 'none' },
                    { name: 'Add users as Basic users (Org requires license)', value: 'basic' },
                    { name: 'Add users as Stakeholders (no license required)', value: 'stakeholder' }
                ],
                default: 'stakeholder'
            }
        ]);
        copyConfig.useDefaultValues = fieldPrompts.useDefaults;
        copyConfig.userAccessLevel = fieldPrompts.userAccessLevel;

        // Show summary and confirm
        const workItemsToProcess = allWorkItems.filter(wi => {
            const originalType = wi.fields['System.WorkItemType'];
            // Include if type exists in target OR if there's a mapping for it
            return targetTypeNames.has(originalType) || copyConfig.typeMappings.has(originalType);
        });

        console.log('\n📊 Copy Summary:');
        console.log(`Work items to copy: ${workItemsToProcess.length}`);
        if (copyConfig.skipMissingTypes) {
            console.log(`Work items to skip (missing types): ${allWorkItems.length - workItemsToProcess.length}`);
        }
        if (copyConfig.typeMappings.size > 0) {
            console.log('Type mappings:');
            copyConfig.typeMappings.forEach((targetType, sourceType) => {
                const count = allWorkItems.filter(wi => wi.fields['System.WorkItemType'] === sourceType).length;
                console.log(`   ${sourceType} → ${targetType} (${count} work items)`);
            });
        }
        console.log(`Use default values for missing fields: ${copyConfig.useDefaultValues ? 'Yes' : 'No'}`);
        const userAccessLevelDisplay = copyConfig.userAccessLevel === 'none' ? 'Do not add' : 
                                     copyConfig.userAccessLevel === 'basic' ? 'Add as Basic users' : 
                                     'Add as Stakeholders';
        console.log(`Missing users handling: ${userAccessLevelDisplay}\n`);

        const { confirm } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirm',
                message: 'Proceed with copying?',
                default: false
            }
        ]);

        if (!confirm) {
            console.log('❌ Copy cancelled by user.');
            return;
        }

        // Copy work items
        console.log('\n🚀 Starting copy process...\n');
        
        // Fetch field definitions for the target project
        const fieldsTimer = startProgress('🔍 Fetching field definitions');
        let targetFieldDefinitions: WorkItemFieldDefinition[] = [];
        try {
            targetFieldDefinitions = await getWorkItemFields(copyConfig.targetOrg, copyConfig.targetProject);
            stopProgress(fieldsTimer, `✓ Found ${targetFieldDefinitions.length} field definitions`);
        } catch (error) {
            stopProgress(fieldsTimer, '⚠️  Could not fetch field definitions');
            console.warn('   Error details:', error);
            console.log('   Continuing without comprehensive field validation...');
        }
        console.log('');
        
        const copiedItems: { [sourceId: number]: number } = {};
        const stateModels: { [workItemType: string]: WorkItemTypeStateModel } = {};
        const detailedTypes: { [workItemType: string]: WorkItemType } = {};

        let processedCount = 0;
        const totalCount = workItemsToProcess.length;

        for (const workItem of workItemsToProcess) {
            const originalWorkItemType = workItem.fields['System.WorkItemType'];
            const targetWorkItemType = copyConfig.typeMappings.get(originalWorkItemType) || originalWorkItemType;
            processedCount++;

            try {
                if (originalWorkItemType !== targetWorkItemType) {
                    console.log(`📝 [${processedCount}/${totalCount}] Copying: ${workItem.fields['System.Title']} (${originalWorkItemType} → ${targetWorkItemType})`);
                } else {
                    console.log(`📝 [${processedCount}/${totalCount}] Copying: ${workItem.fields['System.Title']} (${originalWorkItemType})`);
                }
                
                // Get or cache detailed work item type with field instances (using target type)
                if (!detailedTypes[targetWorkItemType]) {
                    const typeTimer = startProgress(`   🔍 Fetching detailed type info for ${targetWorkItemType}`);
                    try {
                        detailedTypes[targetWorkItemType] = await getWorkItemTypeDetails(
                            copyConfig.targetOrg, 
                            copyConfig.targetProject, 
                            targetWorkItemType
                        );
                        stopProgress(typeTimer, `   ✓ Fetched detailed type info for ${targetWorkItemType}`);
                    } catch (error) {
                        stopProgress(typeTimer, `   ⚠️  Could not fetch detailed type info for ${targetWorkItemType}`);
                        console.warn('   Error details:', error);
                        // Fallback to basic type
                        detailedTypes[targetWorkItemType] = targetTypes.find(t => t.name === targetWorkItemType)!;
                    }
                }
                
                const targetType = detailedTypes[targetWorkItemType];
                
                // Get or cache state model for this work item type (using target type)
                if (!stateModels[targetWorkItemType]) {
                    const stateTimer = startProgress(`   🔍 Fetching states for ${targetWorkItemType}`);
                    try {
                        stateModels[targetWorkItemType] = await getWorkItemTypeStates(
                            copyConfig.targetOrg, 
                            copyConfig.targetProject, 
                            targetWorkItemType
                        );
                        stopProgress(stateTimer, `   ✓ Fetched states for ${targetWorkItemType}`);
                    } catch (error) {
                        stopProgress(stateTimer, `   ⚠️  Could not fetch states for ${targetWorkItemType}`);
                        console.warn('   Error details:', error);
                        stateModels[targetWorkItemType] = { states: [], transitions: {} };
                    }
                }
                
                const mappingResult = await mapWorkItemFields(
                    workItem, 
                    targetType, 
                    copyConfig.useDefaultValues,
                    targetFieldDefinitions,
                    copyConfig.targetOrg,
                    stateModels[targetWorkItemType]
                );
                
                // Process identity fields based on user access level preference
                const shouldAddUsers = copyConfig.userAccessLevel !== 'none';
                if (shouldAddUsers) {
                    const processedFields = await processIdentityFields(
                        mappingResult.fields,
                        copyConfig.targetOrg,
                        shouldAddUsers,
                        targetFieldDefinitions,
                        copyConfig.userAccessLevel
                    );
                    Object.assign(mappingResult.fields, processedFields);
                } else {
                    // If not adding users, remove identity fields
                    const processedFields = await processIdentityFields(
                        mappingResult.fields,
                        copyConfig.targetOrg,
                        false,
                        targetFieldDefinitions,
                        'none'
                    );
                    Object.assign(mappingResult.fields, processedFields);
                }
                
                const newWorkItem = await createWorkItem(
                    copyConfig.targetOrg,
                    copyConfig.targetProject,
                    targetWorkItemType,
                    mappingResult.fields,
                    mappingResult.includeStateInCreation || false
                );

                copiedItems[workItem.id] = newWorkItem.id;
                console.log(`   ✅ Created as ID: ${newWorkItem.id}`);
                
                // Update state and reason only if they were mapped from source but not included in creation
                if (mappingResult.state && mappingResult.reason) {
                    if (mappingResult.includeStateInCreation) {
                        console.log(`   ✅ State "${mappingResult.state}" was included during creation`);
                    } else {
                        try {
                            console.log(`   🔄 Updating state to "${mappingResult.state}" with reason "${mappingResult.reason}"`);
                            await updateWorkItemState(
                                copyConfig.targetOrg,
                                copyConfig.targetProject,
                                newWorkItem.id,
                                mappingResult.state,
                                mappingResult.reason
                            );
                            console.log(`   ✅ State updated successfully`);
                        } catch (error) {
                            console.warn(`   ⚠️  Could not update state: ${error}`);
                            // Continue with the process even if state update fails
                        }
                    }
                }

            } catch (error) {
                console.error(`   ❌ Failed to copy work item ${workItem.id}: ${error}`);
                console.error(`\n💥 Copy process stopped due to error. No further work items will be processed.`);
                console.error(`💡 Fix the issue and run the script again to continue copying.`);
                process.exit(1);
            }
        }

        // Create parent-child relationships
        const relationshipsTimer = startProgress('🔗 Creating parent-child relationships');
        let linksCreated = 0;
        
        for (const workItem of workItemsToProcess) {
            if (!workItem.relations || !copiedItems[workItem.id]) continue;

            for (const relation of workItem.relations) {
                if (relation.rel === 'System.LinkTypes.Hierarchy-Forward') {
                    const match = relation.url.match(/workItems\/(\d+)$/);
                    if (match && match[1]) {
                        const childSourceId = parseInt(match[1]);
                        const parentTargetId = copiedItems[workItem.id];
                        const childTargetId = copiedItems[childSourceId];

                        if (parentTargetId && childTargetId) {
                            try {
                                await addChildLink(
                                    copyConfig.targetOrg,
                                    copyConfig.targetProject,
                                    parentTargetId,
                                    childTargetId
                                );
                                linksCreated++;
                            } catch (error) {
                                console.error(`   ❌ Failed to link ${parentTargetId} -> ${childTargetId}: ${error}`);
                            }
                        }
                    }
                }
            }
        }
        
        stopProgress(relationshipsTimer, `✓ Created ${linksCreated} parent-child relationships`);

        console.log(`\n🎉 Copy completed! Created ${Object.keys(copiedItems).length} work items.`);
        
        if (Object.keys(copiedItems).length > 0) {
            console.log('\n📋 Copied work items:');
            for (const [sourceId, targetId] of Object.entries(copiedItems)) {
                const sourceItem = allWorkItems.find(wi => wi.id === parseInt(sourceId));
                if (sourceItem) {
                    console.log(`   ${sourceId} -> ${targetId}: ${sourceItem.fields['System.Title']}`);
                }
            }
        }

    } catch (error) {
        console.error('❌ Error during copy process:', error);
        process.exit(1);
    }
}

// Check if this file is being run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    copyEpicAndChildren().catch((err) => {
        console.error('❌ Error:', err);
        process.exit(1);
    });
}

export { copyEpicAndChildren };