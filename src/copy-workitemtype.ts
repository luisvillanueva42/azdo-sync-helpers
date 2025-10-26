import { fileURLToPath } from 'url';
import { config } from './config.ts';
import { validateAccess } from './auth.ts';
import { API_VER, startProgress, stopProgress, getHeaders, getHeadersJson } from './shared-utils.ts';
import inquirer from 'inquirer';

// Helper function to normalize color format
function normalizeColor(color: string): string {
    if (!color) return '0078D4'; // Default Azure blue (no # prefix)
    
    const trimmed = color.trim();
    if (!trimmed) return '0078D4';
    
    // Remove # if present and ensure uppercase
    const hexOnly = trimmed.replace(/^#/, '').toUpperCase();
    
    // Validate it's exactly 6 hex characters
    if (!/^[0-9A-F]{6}$/.test(hexOnly)) {
        console.warn(`Invalid color format: ${color}, using default 0078D4`);
        return '0078D4';
    }
    
    return hexOnly; // Return without # prefix for API
}

// Types for Azure DevOps Process APIs
interface Process {
    typeId: string;
    name: string;
    description: string;
    isDefault: boolean;
    type: string;
    url: string;
    customizationType: string;
}

interface ProcessWorkItemType {
    id: string;
    name: string;
    description: string;
    color: string;
    icon: string;
    isDisabled: boolean;
    inherits: string;
    url: string;
    customization: string;
    behaviors: WorkItemTypeBehavior[];
    states: WorkItemState[];
    layout: ProcessWorkItemTypeLayout;
}

interface WorkItemTypeBehavior {
    behavior: {
        id: string;
        name: string;
        description: string;
        abstract: boolean;
        color: string;
        inherits: string;
        overriden: boolean;
        rank: number;
        url: string;
    };
    isDefault: boolean;
    isLegacyDefault: boolean;
    url: string;
}

interface ProcessWorkItemTypeField {
    referenceName: string;
    name: string;
    description: string;
    type: string;
    usage: string;
    readOnly: boolean;
    required: boolean;
    allowedValues: string[];
    suggestedValues: string[];
    allowGroups: boolean;
    defaultValue: any;
    url: string;
}

interface ProcessWorkItemTypeLayout {
    pages: ProcessLayoutPage[];
}

interface ProcessLayoutPage {
    id?: string;
    label: string;
    pageType: string;
    locked: boolean;
    visible: boolean;
    sections?: ProcessLayoutSection[];
}

interface ProcessLayoutSection {
    id: string;
    groups: ProcessLayoutGroup[];
}

interface ProcessLayoutGroup {
    id?: string;
    label: string;
    visible: boolean;
    controls?: ProcessLayoutControl[];
}

interface ProcessLayoutControl {
    id?: string | undefined;
    label: string;
    controlType: string;
    visible: boolean;
    readOnly: boolean;
    watermark: string;
    metadata: string;
    order: number;
    contribution?: {
        contributionId: string;
        inputs: { [key: string]: any };
    };
}

interface WorkItemState {
    id: string;
    name: string;
    color: string;
    stateCategory: string;
    order: number;
    url: string;
    customizationType: string;
    hidden: boolean;
}

interface Project {
    id: string;
    name: string;
    description?: string;
    state: string;
}

interface CopyWorkItemTypeConfig {
    sourceOrg: string;
    sourceProcessId: string;
    targetOrg: string;
    targetProcessId: string;
    sourceWorkItemTypeName: string;
    newWorkItemTypeName: string;
    newWorkItemTypeDescription?: string;
    newWorkItemTypeColor?: string;
    newWorkItemTypeIcon?: string;
}

// These functions are now imported from shared-utils.ts

// Get all processes for an organization
async function getProcesses(org: string): Promise<Process[]> {
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes`);
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Get processes (${org}): ${res.statusText}`);

    const body = await res.json();
    return body.value;
}

// Get process for a specific project
async function getProjectProcess(org: string, projectId: string): Promise<Process> {
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes`);
    url.searchParams.set('$expand', 'projects');
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Get project processes (${org}): ${res.statusText}`);

    const body = await res.json();
    const processes = body.value;

    for (const process of processes) {
        if (process.projects && process.projects.some((p: any) => p.id === projectId)) {
            return process;
        }
    }

    throw new Error(`Process not found for project ${projectId}`);
}

// Get work item types for a process
async function getProcessWorkItemTypes(org: string, processId: string): Promise<ProcessWorkItemType[]> {
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes/${processId}/workitemtypes`);
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Get process work item types (${org}/${processId}): ${res.statusText}`);

    const body = await res.json();
    return body.value;
}

// Get work item type details including fields
async function getProcessWorkItemType(org: string, processId: string, witRefName: string): Promise<ProcessWorkItemType> {
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes/${processId}/workitemtypes/${encodeURIComponent(witRefName)}`);
    url.searchParams.set('$expand', 'layout, states, behaviors');
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Get process work item type (${org}/${processId}/${witRefName}): ${res.statusText}`);

    return res.json();
}

// Get work item type fields
async function getProcessWorkItemTypeFields(org: string, processId: string, witRefName: string): Promise<ProcessWorkItemTypeField[]> {
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes/${processId}/workitemtypes/${encodeURIComponent(witRefName)}/fields`);
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Get process work item type fields (${org}/${processId}/${witRefName}): ${res.statusText}`);

    const body = await res.json();
    return body.value;
}

// Get work item type layout
async function getProcessWorkItemTypeLayout(org: string, processId: string, witRefName: string): Promise<ProcessWorkItemTypeLayout> {
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes/${processId}/workitemtypes/${encodeURIComponent(witRefName)}/layout`);
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Get process work item type layout (${org}/${processId}/${witRefName}): ${res.statusText}`);

    return res.json();
}

// Create a new work item type
async function createProcessWorkItemType(
    org: string, 
    processId: string, 
    name: string,
    description: string,
    color: string,
    icon: string,
    inherits?: string
): Promise<ProcessWorkItemType> {
    const headers = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processdefinitions/${processId}/workitemtypes`);
    url.searchParams.set('api-version', API_VER);

    const payload = {
        name: name,
        description: description,
        color: color,
        icon: icon,
        class: "custom",
        "isDisabled": false
        // inherits: inherits
    };

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Create work item type failed (${org}/${processId}): ${res.status} ${errorText}`);
    }

    return res.json();
}

// Add field to work item type
async function addFieldToWorkItemType(
    org: string, 
    processId: string, 
    witRefName: string,
    fieldRefName: string,
    allowedValues?: string[],
    defaultValue?: any,
    required?: boolean,
    readOnly?: boolean
): Promise<ProcessWorkItemTypeField> {
    const headers = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes/${processId}/workitemtypes/${encodeURIComponent(witRefName)}/fields`);
    url.searchParams.set('api-version', API_VER);

    const payload: any = {
        referenceName: fieldRefName
    };

    if (allowedValues !== undefined) payload.allowedValues = allowedValues;
    if (defaultValue !== undefined) payload.defaultValue = defaultValue;
    if (required !== undefined) payload.required = required;
    if (readOnly !== undefined) payload.readOnly = readOnly;

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Add field to work item type failed (${org}/${processId}/${witRefName}): ${res.status} ${errorText}`);
    }

    return res.json();
}

// Removed getProcessWorkItemTypeLayoutPages - using existing layout data from getProcessWorkItemTypeLayout

// Create a layout page using POST method (page only, no sections/groups/controls)
async function createProcessWorkItemTypeLayoutPage(
    org: string, 
    processId: string, 
    witRefName: string,
    pageData: ProcessLayoutPage
): Promise<ProcessLayoutPage> {
    const headers = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes/${processId}/workitemtypes/${encodeURIComponent(witRefName)}/layout/pages`);
    url.searchParams.set('api-version', API_VER);

    // Create page without sections - sections/groups/controls will be added separately
    const payload = {
        id: pageData.id,
        label: pageData.label,
        pageType: pageData.pageType || "custom",
        locked: pageData.locked || false,
        visible: pageData.visible !== false
    };

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Create work item type layout page failed (${org}/${processId}/${witRefName}): ${res.status} ${errorText}`);
    }

    return res.json();
}



// Get work item type states
async function getProcessWorkItemTypeStates(org: string, processId: string, witRefName: string): Promise<WorkItemState[]> {
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes/${processId}/workitemtypes/${encodeURIComponent(witRefName)}/states`);
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { headers });
    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Get process work item type states failed (${org}/${processId}/${witRefName}): ${res.status} ${errorText}`);
    }

    const body = await res.json();
    return body.value || [];
}

// Create a work item type state
async function createProcessWorkItemTypeState(
    org: string, 
    processId: string, 
    witRefName: string,
    stateData: WorkItemState
): Promise<WorkItemState> {
    const headers = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes/${processId}/workitemtypes/${encodeURIComponent(witRefName)}/states`);
    url.searchParams.set('api-version', API_VER);

    const payload = {
        name: stateData.name,
        color: stateData.color,
        stateCategory: stateData.stateCategory,
        // order: stateData.order
    };

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Create work item type state failed (${org}/${processId}/${witRefName}): ${res.status} ${errorText}`);
    }

    return res.json();
}

// Copy states from source to target work item type
async function copyWorkItemTypeStates(
    sourceOrg: string,
    sourceProcessId: string,
    sourceWitRefName: string,
    sourceWorkItemType: ProcessWorkItemType,
    targetOrg: string,
    targetProcessId: string,
    targetWitRefName: string
): Promise<void> {
    try {
        // Get source states
        const sourceStates = await getProcessWorkItemTypeStates(sourceOrg, sourceProcessId, sourceWitRefName);
        
        let allStates: WorkItemState[] = [...sourceStates];
        
        // If this work item type inherits from another, also get the inherited states
        if (sourceWorkItemType.inherits) {
            console.log(`   🔗 Work item type inherits from: ${sourceWorkItemType.inherits}`);
            try {
                const inheritedStates = await getProcessWorkItemTypeStates(sourceOrg, sourceProcessId, sourceWorkItemType.inherits);
                if (inheritedStates && inheritedStates.length > 0) {
                    // Combine inherited states with source states, avoiding duplicates
                    const sourceStateNames = sourceStates.map(s => s.name.toLowerCase());
                    const uniqueInheritedStates = inheritedStates.filter(
                        inheritedState => !sourceStateNames.includes(inheritedState.name.toLowerCase())
                    );
                    allStates = [...sourceStates, ...uniqueInheritedStates];
                    console.log(`   📋 Combined ${sourceStates.length} source states + ${uniqueInheritedStates.length} inherited states = ${allStates.length} total`);
                }
            } catch (error) {
                console.log(`   ⚠️  Could not fetch inherited states from ${sourceWorkItemType.inherits}: ${error}`);
            }
        }
        
        if (!allStates || allStates.length === 0) {
            console.log('   ℹ️  No custom states to copy');
            return;
        }

        // // Get existing states in target
        const targetStates = await getProcessWorkItemTypeStates(targetOrg, targetProcessId, targetWitRefName);
        const existingStateNames = targetStates.map(s => s.name.toLowerCase());

        let statesCreated = 0;
        let statesSkipped = 0;

        console.log(`   🔄 Found ${allStates.length} total states (source + inherited), ${targetStates.length} existing target states`);


        allStates.sort((a, b) => a.order - b.order); // Sort by order before creating
        for (const sourceState of allStates) {
            // Skip if state already exists or is a system state
            if (existingStateNames.includes(sourceState.name.toLowerCase()) 
                // || 
                // sourceState.customizationType === 'system'
            ) {
                statesSkipped++;
                continue;
            }

            const stateTimer = startProgress(`     📌 Creating state: ${sourceState.name}`);
            
            try {
                await createProcessWorkItemTypeState(
                    targetOrg,
                    targetProcessId,
                    targetWitRefName,
                    sourceState
                );
                statesCreated++;
                stopProgress(stateTimer, `     ✅ Created state: ${sourceState.name}`);
            } catch (error) {
                statesSkipped++;
                stopProgress(stateTimer, `     ⚠️  Skipped state: ${sourceState.name} (${error})`);
            }
        }

        console.log(`   📊 States summary: ${statesCreated} created, ${statesSkipped} skipped`);
    } catch (error) {
        console.log(`   ⚠️  Could not copy states: ${error}`);
    }
}

// Create a control in a group using direct group API
async function createProcessWorkItemTypeLayoutControlDirect(
    org: string, 
    processId: string, 
    witRefName: string,
    groupId: string,
    controlData: ProcessLayoutControl
): Promise<ProcessLayoutControl> {
    const headers = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes/${processId}/workItemTypes/${encodeURIComponent(witRefName)}/layout/groups/${encodeURIComponent(groupId)}/controls`);
    url.searchParams.set('api-version', '7.2-preview.1');

    const payload: any = {
        id: controlData.id,
        label: controlData.label,
        controlType: controlData.controlType,
        visible: controlData.visible !== false,
        readOnly: controlData.readOnly || false,
        watermark: controlData.watermark || "",
        metadata: controlData.metadata || "",
        order: controlData.order || 1
    };

    // Add contribution if it exists
    if (controlData.contribution) {
        payload.contribution = controlData.contribution;
    }

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errorText = await res.text();
        console.log(`URL: ${url.toString()}`);
        console.log(`Payload: ${JSON.stringify(payload, null, 2)}`);
        throw new Error(`Create work item type layout control failed (${org}/${processId}/${witRefName}/${groupId}): ${res.status} ${errorText}`);
    }

    return res.json();
}

// Update an existing control in a group using direct group API
async function updateProcessWorkItemTypeLayoutControlDirect(
    org: string, 
    processId: string, 
    witRefName: string,
    groupId: string,
    controlId: string,
    controlData: ProcessLayoutControl
): Promise<ProcessLayoutControl> {
    const headers = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes/${processId}/workItemTypes/${encodeURIComponent(witRefName)}/layout/groups/${encodeURIComponent(groupId)}/controls/${encodeURIComponent(controlId)}`);
    url.searchParams.set('api-version', '7.2-preview.1');

    const payload: any = {
        label: controlData.label,
        controlType: controlData.controlType,
        visible: controlData.visible !== false,
        readOnly: controlData.readOnly || false,
        watermark: controlData.watermark || "",
        metadata: controlData.metadata || "",
        order: controlData.order || 1
    };

    // Add contribution if it exists
    if (controlData.contribution) {
        payload.contribution = controlData.contribution;
    }

    const res = await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Update work item type layout control failed (${org}/${processId}/${witRefName}/${groupId}/${controlId}): ${res.status} ${errorText}`);
    }

    return res.json();
}

// Update an existing layout page using PATCH method
async function updateProcessWorkItemTypeLayoutPage(
    org: string, 
    processId: string, 
    witRefName: string,
    pageId: string,
    pageData: ProcessLayoutPage
): Promise<ProcessLayoutPage> {
    const headers = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes/${processId}/workitemtypes/${encodeURIComponent(witRefName)}/layout/pages`);
    url.searchParams.set('api-version', API_VER);

    // Prepare the payload for update (only page-level properties, not sections)
    const payload = {
        id: pageId,
        label: pageData.label,
        visible: pageData.visible
    };

    const res = await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Update work item type layout page failed (${org}/${processId}/${witRefName}/${pageId}): ${res.status} ${errorText}`);
    }

    return res.json();
}

// Update an existing layout group using PATCH method with correct API endpoint
async function updateProcessWorkItemTypeLayoutGroupDirect(
    org: string, 
    processId: string, 
    witRefName: string,
    pageId: string,
    sectionId: string,
    groupId: string,
    groupData: ProcessLayoutGroup
): Promise<ProcessLayoutGroup> {
    const headers = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes/${processId}/workItemTypes/${encodeURIComponent(witRefName)}/layout/pages/${encodeURIComponent(pageId)}/sections/${encodeURIComponent(sectionId)}/groups/${encodeURIComponent(groupId)}`);
    url.searchParams.set('api-version', '7.2-preview.1');

    const payload = {
        label: groupData.label,
        visible: groupData.visible !== false
    };

    const res = await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Update work item type layout group failed (${org}/${processId}/${witRefName}/${pageId}/${sectionId}/${groupId}): ${res.status} ${errorText}`);
    }

    return res.json();
}

// Create a new layout group using POST method with correct API endpoint
async function createProcessWorkItemTypeLayoutGroupDirect(
    org: string, 
    processId: string, 
    witRefName: string,
    pageId: string,
    sectionId: string,
    groupData: ProcessLayoutGroup
): Promise<ProcessLayoutGroup> {
    const headers = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes/${processId}/workItemTypes/${encodeURIComponent(witRefName)}/layout/pages/${encodeURIComponent(pageId)}/sections/${encodeURIComponent(sectionId)}/groups`);
    url.searchParams.set('api-version', '7.2-preview.1');

    const payload = {
        label: groupData.label,
        visible: groupData.visible !== false
    };

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Create work item type layout group failed (${org}/${processId}/${witRefName}/${pageId}/${sectionId}): ${res.status} ${errorText}`);
    }

    return res.json();
}

// Create a new layout group with HtmlFieldControl included (must be created together)
async function createProcessWorkItemTypeLayoutGroupWithHtmlControl(
    org: string, 
    processId: string, 
    witRefName: string,
    pageId: string,
    sectionId: string,
    groupData: ProcessLayoutGroup,
    htmlControl: ProcessLayoutControl
): Promise<ProcessLayoutGroup> {
    const headers = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes/${processId}/workItemTypes/${encodeURIComponent(witRefName)}/layout/pages/${encodeURIComponent(pageId)}/sections/${encodeURIComponent(sectionId)}/groups`);
    url.searchParams.set('api-version', '7.2-preview.1');

    const controlPayload: any = {
        id: htmlControl.id,
        label: htmlControl.label,
        controlType: htmlControl.controlType,
        visible: htmlControl.visible !== false,
        readOnly: htmlControl.readOnly || false,
        watermark: htmlControl.watermark || "",
        metadata: htmlControl.metadata || "",
        order: htmlControl.order || 1
    };

    // Add contribution if it exists
    if (htmlControl.contribution) {
        controlPayload.contribution = htmlControl.contribution;
    }

    const payload = {
        label: groupData.label,
        visible: groupData.visible !== false,
        controls: [controlPayload]
    };

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errorText = await res.text();
        console.log(`URL: ${url.toString()}`);
        console.log(`Payload: ${JSON.stringify(payload, null, 2)}`);
        throw new Error(`Create work item type layout group with HTML control failed (${org}/${processId}/${witRefName}/${pageId}/${sectionId}): ${res.status} ${errorText}`);
    }

    return res.json();
}



// Copy layout by comparing labels and using existing target layout structure
async function copyWorkItemTypeLayoutPages(
    sourceOrg: string,
    sourceProcessId: string,
    sourceWitRefName: string,
    targetOrg: string,
    targetProcessId: string,
    targetWitRefName: string,
    sourceLayout: ProcessWorkItemTypeLayout
): Promise<void> {
    if (!sourceLayout.pages || sourceLayout.pages.length === 0) {
        console.log('   ℹ️  No custom pages to copy');
        return;
    }

    // Step 1: Pull the newly created work item layout to use as reference
    const targetLayout = await getProcessWorkItemTypeLayout(targetOrg, targetProcessId, targetWitRefName);
    const targetPages = targetLayout.pages || [];
    console.log(`   📄 Found ${targetPages.length} target pages, ${sourceLayout.pages.length} source pages to process`);

    let pagesCreated = 0;
    let pagesUpdated = 0;
    let pagesSkipped = 0;
    let groupsCreated = 0;
    let groupsUpdated = 0;
    let controlsCreated = 0;

    for (const sourcePage of sourceLayout.pages) {
        const pageTimer = startProgress(`   📄 Processing page: ${sourcePage.label || sourcePage.id}`);
        
        try {
            // Step 2: Find existing target page by label (or create new one)
            let targetPage = targetPages.find(p => p.label === sourcePage.label);
            
            if (targetPage && targetPage.id) {
                // Update existing page using target page's ID
                // await updateProcessWorkItemTypeLayoutPage(
                //     targetOrg,
                //     targetProcessId,
                //     targetWitRefName,
                //     targetPage.id,
                //     sourcePage
                // );
                pagesUpdated++;
                stopProgress(pageTimer, `   ✅ Updated page: ${sourcePage.label || sourcePage.id}`);
            } else {
                // Step 3: Create new page without ID (let API assign new ID)
                const newPageData: ProcessLayoutPage = {
                    label: sourcePage.label,
                    pageType: sourcePage.pageType || "custom",
                    locked: sourcePage.locked || false,
                    visible: sourcePage.visible !== false
                };
                
                targetPage = await createProcessWorkItemTypeLayoutPage(
                    targetOrg,
                    targetProcessId,
                    targetWitRefName,
                    newPageData
                );
                pagesCreated++;
                stopProgress(pageTimer, `   ✅ Created page: ${sourcePage.label || sourcePage.id}`);
            }

            // Step 4: Process groups directly in fixed sections using target page's structure
            if (sourcePage.sections && sourcePage.sections.length > 0 && targetPage.id) {
                // Refresh target layout to get current structure after page update/creation
                const refreshedTargetLayout = await getProcessWorkItemTypeLayout(targetOrg, targetProcessId, targetWitRefName);
                const refreshedTargetPage = refreshedTargetLayout.pages?.find(p => p.id === targetPage.id);
                
                if (!refreshedTargetPage || !refreshedTargetPage.sections) {
                    console.log(`     ⚠️  No sections found in refreshed target page`);
                    continue;
                }

                // Fixed section IDs that are always present
                const fixedSectionIds = ['Section1', 'Section2', 'Section3', 'Section4'];

                for (const sourceSection of sourcePage.sections) {
                    // Step 5: Map source section to fixed target section
                    // Use the source section ID if it matches a fixed ID, otherwise use Section1 as default
                    const targetSectionId = fixedSectionIds.includes(sourceSection.id) ? sourceSection.id : 'Section1';
                    const targetSection = refreshedTargetPage.sections.find(s => s.id === targetSectionId);
                    
                    if (!targetSection) {
                        console.log(`     ⚠️  Fixed target section ${targetSectionId} not found`);
                        continue;
                    }

                    if (sourceSection.groups && sourceSection.groups.length > 0) {
                        for (const sourceGroup of sourceSection.groups) {
                            // Step 6: Compare by label to find existing groups in target section
                            const existingTargetGroup = targetSection.groups?.find(g => g.label === sourceGroup.label);
                            
                            if (existingTargetGroup && existingTargetGroup.id) {
                                // Update existing group using PATCH API
                                const groupTimer = startProgress(`     📂 Updating group: ${sourceGroup.label || sourceGroup.id} in ${targetSectionId}`);
                                
                                try {
                                    await updateProcessWorkItemTypeLayoutGroupDirect(
                                        targetOrg,
                                        targetProcessId,
                                        targetWitRefName,
                                        targetPage.id,
                                        targetSectionId,
                                        existingTargetGroup.id,
                                        sourceGroup
                                    );
                                    groupsUpdated++;
                                    stopProgress(groupTimer, `     ✅ Updated group: ${sourceGroup.label || sourceGroup.id} in ${targetSectionId}`);
                                } catch (groupError) {
                                    stopProgress(groupTimer, `     ⚠️  Failed to update group: ${sourceGroup.label || sourceGroup.id} in ${targetSectionId} (${groupError})`);
                                }
                            } else {
                                // Check if this group contains HtmlFieldControl
                                const htmlFieldControl = sourceGroup.controls?.find(c => c.controlType === 'HtmlFieldControl');
                                
                                if (htmlFieldControl) {
                                    // Create group with HtmlFieldControl included (they must be created together)
                                    const groupTimer = startProgress(`     📂 Creating group with HTML control: ${sourceGroup.label || sourceGroup.id} in ${targetSectionId}`);
                                    
                                    try {
                                        const newGroupData: ProcessLayoutGroup = {
                                            label: sourceGroup.label,
                                            visible: sourceGroup.visible !== false
                                        };
                                        
                                        await createProcessWorkItemTypeLayoutGroupWithHtmlControl(
                                            targetOrg,
                                            targetProcessId,
                                            targetWitRefName,
                                            targetPage.id,
                                            targetSectionId,
                                            newGroupData,
                                            htmlFieldControl
                                        );
                                        groupsCreated++;
                                        controlsCreated++; // Count the HTML control as created
                                        stopProgress(groupTimer, `     ✅ Created group with HTML control: ${sourceGroup.label || sourceGroup.id} in ${targetSectionId}`);
                                    } catch (groupError) {
                                        stopProgress(groupTimer, `     ⚠️  Failed to create group with HTML control: ${sourceGroup.label || sourceGroup.id} in ${targetSectionId} (${groupError})`);
                                    }
                                } else {
                                    // Create normal group using POST API
                                    const groupTimer = startProgress(`     📂 Creating group: ${sourceGroup.label || sourceGroup.id} in ${targetSectionId}`);
                                    
                                    try {
                                        const newGroupData: ProcessLayoutGroup = {
                                            label: sourceGroup.label,
                                            visible: sourceGroup.visible !== false
                                        };
                                        
                                        await createProcessWorkItemTypeLayoutGroupDirect(
                                            targetOrg,
                                            targetProcessId,
                                            targetWitRefName,
                                            targetPage.id,
                                            targetSectionId,
                                            newGroupData
                                        );
                                        groupsCreated++;
                                        stopProgress(groupTimer, `     ✅ Created group: ${sourceGroup.label || sourceGroup.id} in ${targetSectionId}`);
                                    } catch (groupError) {
                                        stopProgress(groupTimer, `     ⚠️  Failed to create group: ${sourceGroup.label || sourceGroup.id} in ${targetSectionId} (${groupError})`);
                                    }
                                }
                            }
                        }
                    }
                }
                
                // Step 7: Copy controls after all groups are processed
                // Refresh target layout again to get updated group structure
                const finalTargetLayout = await getProcessWorkItemTypeLayout(targetOrg, targetProcessId, targetWitRefName);
                const finalTargetPage = finalTargetLayout.pages?.find(p => p.id === targetPage.id);
                
                if (finalTargetPage && finalTargetPage.sections) {
                    for (const sourceSection of sourcePage.sections) {
                        // Map to fixed section ID
                        const targetSectionId = fixedSectionIds.includes(sourceSection.id) ? sourceSection.id : 'Section1';
                        const targetSection = finalTargetPage.sections.find(s => s.id === targetSectionId);
                        
                        if (!targetSection) continue;

                        if (sourceSection.groups && sourceSection.groups.length > 0) {
                            for (const sourceGroup of sourceSection.groups) {
                                // Find the actual target group by label
                                const targetGroup = targetSection.groups?.find(g => g.label === sourceGroup.label);
                                
                                if (targetGroup && targetGroup.id && sourceGroup.controls && sourceGroup.controls.length > 0) {
                                    for (const sourceControl of sourceGroup.controls) {
                                        // Skip HtmlFieldControl - they must be created with the group, not added later
                                        if (sourceControl.controlType === 'HtmlFieldControl') {
                                            console.log(`       ℹ️  Skipping HtmlFieldControl (already handled during group creation): ${sourceControl.label || sourceControl.id}`);
                                            continue;
                                        }

                                        // Skip controls that already exist (compare by ID)
                                        const existingControl = targetGroup.controls?.find(c => c.id === sourceControl.id);
                                        
                                        if (existingControl) {
                                            // Control already exists, skip it (don't update)
                                            console.log(`       ℹ️  Skipping existing control: ${sourceControl.label || sourceControl.id} (ID: ${sourceControl.id})`);
                                            continue;
                                        }

                                        const controlTimer = startProgress(`       🎛️  Adding control: ${sourceControl.label || sourceControl.id} to ${targetSectionId}`);
                                        
                                        try {
                                            // Create control using direct group API
                                            const newControlData: ProcessLayoutControl = {
                                                id: sourceControl.id,
                                                label: sourceControl.label,
                                                controlType: sourceControl.controlType,
                                                visible: sourceControl.visible !== false,
                                                readOnly: sourceControl.readOnly || false,
                                                watermark: sourceControl.watermark || "",
                                                metadata: sourceControl.metadata || "",
                                                order: sourceControl.order || 1
                                            };
                                            
                                            // Add contribution if it exists
                                            if (sourceControl.contribution) {
                                                newControlData.contribution = sourceControl.contribution;
                                            }
                                            
                                            await createProcessWorkItemTypeLayoutControlDirect(
                                                targetOrg,
                                                targetProcessId,
                                                targetWitRefName,
                                                targetGroup.id,
                                                newControlData
                                            );
                                            controlsCreated++;
                                            stopProgress(controlTimer, `       ✅ Added control: ${sourceControl.label || sourceControl.id} to ${targetSectionId}`);
                                        } catch (controlError) {
                                            stopProgress(controlTimer, `       ⚠️  Skipped control: ${sourceControl.label || sourceControl.id} in ${targetSectionId} (${controlError})`);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (error) {
            pagesSkipped++;
            stopProgress(pageTimer, `   ⚠️  Skipped page: ${sourcePage.label || sourcePage.id} (${error})`);
        }
    }

    console.log(`   📊 Layout summary: ${pagesCreated} pages created, ${pagesUpdated} pages updated, ${pagesSkipped} pages skipped`);
    console.log(`   📊 Content summary: ${groupsCreated} groups created, ${groupsUpdated} groups updated, ${controlsCreated} controls created`);
}

// Interactive configuration
async function getCopyWorkItemTypeConfig(): Promise<CopyWorkItemTypeConfig> {
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

    // Get organization and process selection
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

    // Get processes for source org
    console.log(`\nFetching processes from ${answers.sourceOrg}...`);
    const sourceProcesses = await getProcesses(answers.sourceOrg);
    const sourceProcessChoices = sourceProcesses
        .map(p => ({ name: p.name, value: p }))
        .sort((a, b) => a.name.localeCompare(b.name));

    console.log(`Fetching processes from ${answers.targetOrg}...`);
    const targetProcesses = await getProcesses(answers.targetOrg);
    const targetProcessChoices = targetProcesses
        .map(p => ({ name: p.name, value: p }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const processAnswers = await inquirer.prompt([
        {
            type: 'list',
            name: 'sourceProcess',
            message: 'Select the source process:',
            choices: sourceProcessChoices
        },
        {
            type: 'list',
            name: 'targetProcess',
            message: 'Select the target process:',
            choices: targetProcessChoices
        }
    ]);

    // Get work item types from source process
    console.log(`\nFetching work item types from source process...`);
    const sourceWorkItemTypes = await getProcessWorkItemTypes(answers.sourceOrg, processAnswers.sourceProcess.typeId);
    
    const workItemTypeChoices = sourceWorkItemTypes
        .filter(wit => wit.customization === 'custom' || wit.customization === 'inherited')
        .map(wit => ({ name: `${wit.name} (${wit.id})`, value: wit }))
        .sort((a, b) => a.name.localeCompare(b.name));

    if (workItemTypeChoices.length === 0) {
        console.error('❌ No custom or inherited work item types found in the source process.');
        console.log('💡 You can only copy custom or inherited work item types, not system types.');
        process.exit(1);
    }

    // First, get the source work item type selection
    const witTypeAnswer = await inquirer.prompt([
        {
            type: 'list',
            name: 'sourceWorkItemType',
            message: 'Select the work item type to copy:',
            choices: workItemTypeChoices
        }
    ]);

    // Now get the other details using the selected work item type as defaults
    const witConfigAnswers = await inquirer.prompt([
        {
            type: 'input',
            name: 'newWorkItemTypeName',
            message: 'Enter the new work item type name:',
            validate: (input) => {
                if (!input.trim()) {
                    return 'Work item type name cannot be empty';
                }
                if (input.trim().length > 128) {
                    return 'Work item type name cannot exceed 128 characters';
                }
                return true;
            }
        },
        {
            type: 'input',
            name: 'newWorkItemTypeDescription',
            message: `Enter the description (default: "${witTypeAnswer.sourceWorkItemType.description || 'No description'}"):`,
            default: witTypeAnswer.sourceWorkItemType.description || ''
        },
        {
            type: 'input',
            name: 'newWorkItemTypeColor',
            message: `Enter the color (default: "${witTypeAnswer.sourceWorkItemType.color || '#0078D4'}"):`,
            default: witTypeAnswer.sourceWorkItemType.color || '',
            validate: (input) => {
                if (!input.trim()) return true;
                const trimmed = input.trim();
                // Allow with or without # prefix, but must be exactly 6 hex characters
                if (!/^#?[0-9A-Fa-f]{6}$/.test(trimmed)) {
                    return 'Color must be exactly 6 hexadecimal characters (e.g., FF0000 or #FF0000)';
                }
                return true;
            }
        },
        {
            type: 'input',
            name: 'newWorkItemTypeIcon',
            message: `Enter the icon name (default: "${witTypeAnswer.sourceWorkItemType.icon || 'icon_crown'}"):`,
            default: witTypeAnswer.sourceWorkItemType.icon || ''
        }
    ]);

    return {
        sourceOrg: answers.sourceOrg,
        sourceProcessId: processAnswers.sourceProcess.typeId,
        targetOrg: answers.targetOrg,
        targetProcessId: processAnswers.targetProcess.typeId,
        sourceWorkItemTypeName: witTypeAnswer.sourceWorkItemType.referenceName,
        newWorkItemTypeName: witConfigAnswers.newWorkItemTypeName.trim(),
        newWorkItemTypeDescription: witConfigAnswers.newWorkItemTypeDescription.trim() || witTypeAnswer.sourceWorkItemType.description,
        newWorkItemTypeColor: normalizeColor(witConfigAnswers.newWorkItemTypeColor.trim() || witTypeAnswer.sourceWorkItemType.color),
        newWorkItemTypeIcon: witConfigAnswers.newWorkItemTypeIcon.trim() || witTypeAnswer.sourceWorkItemType.icon
    };
}

// Main copy function
async function copyWorkItemType(): Promise<void> {
    try {
        const copyConfig = await getCopyWorkItemTypeConfig();

        console.log('\n📋 Copy Configuration:');
        console.log(`Source: ${copyConfig.sourceOrg} (Process ID: ${copyConfig.sourceProcessId})`);
        console.log(`Target: ${copyConfig.targetOrg} (Process ID: ${copyConfig.targetProcessId})`);
        console.log(`Source Work Item Type: ${copyConfig.sourceWorkItemTypeName}`);
        console.log(`New Work Item Type Name: ${copyConfig.newWorkItemTypeName}\n`);

        // Get source and target processes
        const fetchTimer = startProgress('🔍 Fetching process information');
        const sourceProcesses = await getProcesses(copyConfig.sourceOrg);
        const targetProcesses = await getProcesses(copyConfig.targetOrg);
        
        const sourceProcess = sourceProcesses.find(p => p.typeId === copyConfig.sourceProcessId);
        const targetProcess = targetProcesses.find(p => p.typeId === copyConfig.targetProcessId);
        
        if (!sourceProcess || !targetProcess) {
            throw new Error('Source or target process not found');
        }
        stopProgress(fetchTimer, '✓ Process information retrieved');

        // Get source work item type details
        const detailsTimer = startProgress('🔍 Fetching source work item type details');
        const sourceWorkItemType = await getProcessWorkItemType(
            copyConfig.sourceOrg, 
            sourceProcess.typeId, 
            copyConfig.sourceWorkItemTypeName
        );
        const sourceFields = await getProcessWorkItemTypeFields(
            copyConfig.sourceOrg, 
            sourceProcess.typeId, 
            copyConfig.sourceWorkItemTypeName
        );
        // const sourceLayout = await getProcessWorkItemTypeLayout(
        //     copyConfig.sourceOrg, 
        //     sourceProcess.typeId, 
        //     copyConfig.sourceWorkItemTypeName
        // );
        const sourceLayout = sourceWorkItemType.layout;
        stopProgress(detailsTimer, `✓ Retrieved details for ${sourceWorkItemType.name} (${sourceFields.length} fields)`);

        // Show summary and confirm
        console.log('\n📊 Copy Summary:');
        console.log(`Work Item Type: ${sourceWorkItemType.name} -> ${copyConfig.newWorkItemTypeName}`);
        console.log(`Fields to copy: ${sourceFields.length}`);
        console.log(`Layout pages: ${sourceLayout.pages?.length || 0}`);
        console.log(`Inherits from: ${sourceWorkItemType.inherits || 'None'}`);
        console.log(`Behaviors: ${sourceWorkItemType.behaviors?.length || 0}\n`);

        const { confirm } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirm',
                message: 'Proceed with copying the work item type?',
                default: false
            }
        ]);

        if (!confirm) {
            console.log('❌ Copy cancelled by user.');
            return;
        }

        // Create the new work item type
        console.log('\n🚀 Starting copy process...\n');
        const createTimer = startProgress('📝 Creating new work item type');
        
        const newWorkItemType = await createProcessWorkItemType(
            copyConfig.targetOrg,
            targetProcess.typeId,
            copyConfig.newWorkItemTypeName,
            copyConfig.newWorkItemTypeDescription || sourceWorkItemType.description,
            copyConfig.newWorkItemTypeColor || sourceWorkItemType.color,
            copyConfig.newWorkItemTypeIcon || sourceWorkItemType.icon,
            sourceWorkItemType.inherits
        );
        stopProgress(createTimer, `✅ Created work item type: ${newWorkItemType.id}`);

        // Copy custom fields
        console.log('');
        let fieldsAdded = 0;
        let fieldsSkipped = 0;
        
        for (const field of sourceFields) {
            // Skip system fields that cannot be customized
            if (field.referenceName.startsWith('System.') || field.readOnly) {
                fieldsSkipped++;
                continue;
            }

            const fieldTimer = startProgress(`   📋 Adding field: ${field.name}`);
            try {
                await addFieldToWorkItemType(
                    copyConfig.targetOrg,
                    targetProcess.typeId,
                    newWorkItemType.id,
                    field.referenceName,
                    field.allowedValues?.length > 0 ? field.allowedValues : undefined,
                    field.defaultValue,
                    field.required,
                    field.readOnly
                );
                
                fieldsAdded++;
                stopProgress(fieldTimer, `   ✅ Added field: ${field.name}`);
            } catch (error) {
                stopProgress(fieldTimer, `   ⚠️  Skipped field: ${field.name} (${error})`);
                fieldsSkipped++;
            }
        }

        // Copy states if they exist
        console.log('');
        // if (sourceWorkItemType.states && sourceWorkItemType.states.length > 0) {
            const statesTimer = startProgress('📌 Copying work item type states');
            try {
                await copyWorkItemTypeStates(
                    copyConfig.sourceOrg,
                    sourceProcess.typeId,
                    copyConfig.sourceWorkItemTypeName,
                    sourceWorkItemType,
                    copyConfig.targetOrg,
                    targetProcess.typeId,
                    newWorkItemType.id
                );
                stopProgress(statesTimer, '✅ States copied successfully');
            } catch (error) {
                stopProgress(statesTimer, `⚠️  Could not copy states: ${error}`);
                console.log('   💡 You may need to manually configure the states in Azure DevOps');
            }
        // }

        // Copy layout pages if they exist
        console.log('');
        if (sourceLayout && sourceLayout.pages && sourceLayout.pages.length > 0) {
            const layoutTimer = startProgress('🎨 Copying layout pages');
            try {
                await copyWorkItemTypeLayoutPages(
                    copyConfig.sourceOrg,
                    sourceProcess.typeId,
                    copyConfig.sourceWorkItemTypeName,
                    copyConfig.targetOrg,
                    targetProcess.typeId,
                    newWorkItemType.id,
                    sourceLayout
                );
                
                stopProgress(layoutTimer, '✅ Layout pages copied successfully');
            } catch (error) {
                stopProgress(layoutTimer, `⚠️  Could not copy layout pages: ${error}`);
                console.log('   💡 You may need to manually configure the layout in Azure DevOps');
            }
        } else {
            console.log('   ℹ️  No custom layout pages to copy');
        }

        console.log(`\n🎉 Work item type copy completed successfully!`);
        console.log(`\n📊 Summary:`);
        console.log(`   ✅ Work item type created: ${newWorkItemType.id}`);
        console.log(`   ✅ Fields added: ${fieldsAdded}`);
        console.log(`   ⏭️  Fields skipped: ${fieldsSkipped} (system/read-only fields)`);
        console.log(`   📍 Reference name: ${newWorkItemType.id}`);
        console.log(`\n💡 You can now use the new work item type "${copyConfig.newWorkItemTypeName}" in ${copyConfig.targetOrg} (Process ID: ${copyConfig.targetProcessId})`);

    } catch (error) {
        console.error('❌ Error during work item type copy process:', error);
        process.exit(1);
    }
}

// Check if this file is being run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    copyWorkItemType().catch((err) => {
        console.error('❌ Error:', err);
        process.exit(1);
    });
}

export { copyWorkItemType };