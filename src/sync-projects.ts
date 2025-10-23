import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from './config.ts';
import { checkOrgAccess } from './auth.ts';
import inquirer from 'inquirer';
import { writeFileSync, readFileSync } from 'fs';

let {
    AZDO_PAT,
    SOURCE_ORG,
    TARGET_ORG,
    VISIBILITY,
    DRY_RUN
} = config;

async function ensureValidPAT(org: string): Promise<string> {
    let pat = AZDO_PAT;
    
    // Check if PAT is empty or invalid
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
    const API_VER = '7.1';
    const AUTH = 'Basic ' + Buffer.from(':' + pat).toString('base64');
    const headers = { Authorization: AUTH };
    
    try {
        const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes`);
        url.searchParams.set('api-version', API_VER);
        const res = await fetch(url, { headers });
        
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                // PAT is invalid, prompt for new one
                const answer = await inquirer.prompt([
                    {
                        type: 'password',
                        name: 'pat',
                        message: 'Invalid PAT. Enter a valid Azure DevOps Personal Access Token (PAT):',
                        mask: '*'
                    }
                ]);
                pat = answer.pat;
                
                // Test the new PAT
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
    if (pat !== AZDO_PAT && pat) {
        try {
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = dirname(__filename);
            const configPath = join(__dirname, 'config.ts');
            let configText = readFileSync(configPath, 'utf-8');
            configText = configText.replace(/AZDO_PAT:\s*['\"][^'\"]*['\"]/, `AZDO_PAT: '${pat}'`);
            writeFileSync(configPath, configText);
            AZDO_PAT = pat;
            config.AZDO_PAT = pat;
        } catch (err) {
            console.warn('Warning: Could not update config.ts with new PAT:', err);
        }
    }

    return pat;
}

if (!AZDO_PAT) {
    console.error('Missing AZDO_PAT environment variable');
    // Don't exit here, let ensureValidPAT handle it
}

const API_VER = '7.1';

async function getHeaders(org?: string): Promise<{ Authorization: string; 'Content-Type'?: string }> {
    const pat = org ? await ensureValidPAT(org) : AZDO_PAT || '';
    const AUTH = 'Basic ' + Buffer.from(':' + pat).toString('base64');
    return { Authorization: AUTH };
}

async function getHeadersJson(org?: string): Promise<{ Authorization: string; 'Content-Type': string }> {
    const headers = await getHeaders(org);
    return { ...headers, 'Content-Type': 'application/json' };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -----------------------------
// TYPES
// -----------------------------

interface Project {
    id: string;
    name: string;
    description?: string;
    state: string;
}

interface Process {
    typeId: string;
    name: string;
    isDefault: boolean;
}

interface ProjectCapabilities {
    capabilities: {
        processTemplate?: { templateTypeId?: string };
        versioncontrol?: { sourceControlType?: string };
    };
    description?: string;
}

interface Operation {
    id: string;
    status: 'notSet' | 'queued' | 'inProgress' | 'succeeded' | 'failed' | 'cancelled';
    resultMessage?: string;
    detailedMessage?: string;
}

// -----------------------------
// HELPER FUNCTIONS
// -----------------------------

export async function listProjects(org: string): Promise<Project[]> {
    const results: Project[] = [];
    let token: string | null = null;

    // Ensure we have a valid PAT
    const validPAT = await ensureValidPAT(org);
    const AUTH = 'Basic ' + Buffer.from(':' + validPAT).toString('base64');
    const headers = { Authorization: AUTH };

    do {
        const url = new URL(`https://dev.azure.com/${org}/_apis/projects`);
        url.searchParams.set('stateFilter', 'wellFormed');
        url.searchParams.set('$top', '100');
        if (token) url.searchParams.set('continuationToken', token);
        url.searchParams.set('api-version', API_VER);

        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`List projects (${org}): ${res.statusText}`);

        const body = await res.json();
        results.push(...body.value);
        token = res.headers.get('x-ms-continuationtoken');
    } while (token);

    return results;
}

async function getProjectWithCapabilities(org: string, idOrName: string): Promise<ProjectCapabilities> {
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/projects/${encodeURIComponent(idOrName)}`);
    url.searchParams.set('includeCapabilities', 'true');
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Get project (${org}/${idOrName}): ${res.statusText}`);

    return res.json();
}

export async function listProcesses(org: string): Promise<Process[]> {
    // Ensure we have a valid PAT
    const validPAT = await ensureValidPAT(org);
    const AUTH = 'Basic ' + Buffer.from(':' + validPAT).toString('base64');
    const headers = { Authorization: AUTH };
    
    const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes`);
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`List processes (${org}): ${res.statusText}`);

    const body = await res.json();
    return body.value;
}

async function queueCreateProject(org: string, name: string, description: string, processTypeId: string, visibility: string): Promise<string | null> {
    const headersJson = await getHeadersJson(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/projects`);
    url.searchParams.set('api-version', API_VER);

    const payload = {
        name,
        description,
        capabilities: {
            versioncontrol: { sourceControlType: 'Git' },
            processTemplate: { templateTypeId: processTypeId },
        },
        visibility,
    };

    const res = await fetch(url, { method: 'POST', headers: headersJson, body: JSON.stringify(payload) });

    if (res.status === 202) {
        const op = await res.json();
        return op.id;
    }
    if (res.status === 409) {
        console.log(`Project "${name}" already exists in ${org}`);
        return null;
    }

    throw new Error(`Create project failed (${org}/${name}): ${res.statusText}`);
}

async function waitForOperation(org: string, opId: string, timeoutMs = 10 * 60 * 1000): Promise<void> {
    const headers = await getHeaders(org);
    const start = Date.now();
    while (true) {
        const url = new URL(`https://dev.azure.com/${org}/_apis/operations/${opId}`);
        url.searchParams.set('api-version', API_VER);

        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`Poll operation ${opId}: ${res.statusText}`);

        const op: Operation = await res.json();

        if (op.status === 'succeeded') return;
        if (['failed', 'cancelled'].includes(op.status)) {
            throw new Error(`Operation ${op.status}: ${op.resultMessage ?? op.detailedMessage ?? ''}`);
        }

        if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for project creation.');
        await sleep(5000);
    }
}

async function deleteProject(org: string, projectId: string): Promise<void> {
    const headers = await getHeaders(org);
    const url = new URL(`https://dev.azure.com/${org}/_apis/projects/${projectId}`);
    url.searchParams.set('api-version', API_VER);

    const res = await fetch(url, { 
        method: 'DELETE',
        headers 
    });

    if (res.status === 404) {
        console.log(`   Project already deleted or doesn't exist`);
        return;
    }

    if (!res.ok) {
        throw new Error(`Delete project failed: ${res.statusText}`);
    }

    if (res.status === 204) {
        return; // Successful deletion, no content
    }

    // If we get here, we need to wait for the operation to complete
    const operation = await res.json();
    await waitForOperation(org, operation.id);
}

// -----------------------------
// MAIN
// -----------------------------

export async function listSourceProjects(): Promise<void> {
    if (!SOURCE_ORG) {
        console.error('Missing SOURCE_ORG in .env');
        process.exit(1);
    }
    
    // Ensure we have a valid PAT before proceeding
    const validPAT = await ensureValidPAT(SOURCE_ORG);
    
    const projects = await listProjects(SOURCE_ORG);
    console.log(JSON.stringify(projects, null, 2));
}

export interface ProjectAction {
    projectId: string;
    projectName: string;
    action: 'skip' | 'create' | 'recreate';
}

export async function copyProjectsFromSourceToTarget(
    sourceOrg?: string, 
    targetOrg?: string, 
    dryRun: boolean = true, 
    targetProcessName?: string,
    projectActions: ProjectAction[] = []
): Promise<void> {
    const effectiveSourceOrg = sourceOrg || SOURCE_ORG;
    const effectiveTargetOrg = targetOrg || TARGET_ORG;
    
    if (!effectiveSourceOrg || !effectiveTargetOrg) {
        throw new Error('Source and target organizations must be provided either through environment variables or parameters');
    }

    const [srcProjects, dstProjects, srcProcesses, dstProcesses] = await Promise.all([
        listProjects(effectiveSourceOrg),
        listProjects(effectiveTargetOrg),
        listProcesses(effectiveSourceOrg),
        listProcesses(effectiveTargetOrg),
    ]);

    const dstNames = new Set(dstProjects.map((p) => p.name.toLowerCase()));
    const dstDefaultProc = dstProcesses.find((p) => p.isDefault) || dstProcesses[0];

    if (!dstDefaultProc) {
        throw new Error(`No process templates found in target org ${effectiveTargetOrg}`);
    }

    // If no specific actions provided, create new projects only
    const actions = projectActions.length > 0 ? projectActions : 
        srcProjects.map(sp => ({
            projectId: sp.id,
            projectName: sp.name,
            action: dstNames.has(sp.name.toLowerCase()) ? 'skip' : 'create'
        }));

    // Group projects by action
    const projectsByAction = {
        create: actions.filter(a => a.action === 'create'),
        recreate: actions.filter(a => a.action === 'recreate'),
        skip: actions.filter(a => a.action === 'skip')
    };

    console.log('\nProject Copy Summary:');
    console.log(`Source Organization (${effectiveSourceOrg}): ${srcProjects.length} projects`);
    console.log(`Target Organization (${effectiveTargetOrg}): ${dstProjects.length} existing projects`);
    console.log(`Projects to skip: ${projectsByAction.skip.length}`);
    console.log(`Projects to create: ${projectsByAction.create.length}`);
    console.log(`Projects to recreate: ${projectsByAction.recreate.length}`);
    console.log(`Target process to use: ${targetProcessName || dstDefaultProc.name}\n`);

    // Show detailed action lists
    if (projectsByAction.skip.length > 0) {
        console.log('Projects that will be skipped:');
        projectsByAction.skip.forEach(p => console.log(`  • ${p.projectName}`));
        console.log('');
    }

    if (projectsByAction.recreate.length > 0) {
        console.log('Projects that will be recreated:');
        projectsByAction.recreate.forEach(p => console.log(`  • ${p.projectName}`));
        console.log('');
    }

    // Handle recreations first if not in dry run
    if (!dryRun) {
        for (const action of projectsByAction.recreate) {
            const existingProject = dstProjects.find(p => p.name.toLowerCase() === action.projectName.toLowerCase());
            if (existingProject) {
                console.log(`→ Deleting existing project: ${action.projectName}`);
                await deleteProject(effectiveTargetOrg!, existingProject.id);
                console.log(`  ✓ Project deleted successfully`);
            }
        }
    }

    // Process all projects
    for (const sp of srcProjects) {
        const action = actions.find(a => a.projectId === sp.id);
        if (!action || action.action === 'skip') {
            continue;
        }

    const srcDetail = await getProjectWithCapabilities(effectiveSourceOrg!, sp.id);
        const srcProcId = srcDetail.capabilities.processTemplate?.templateTypeId;

        const srcProc = srcProcId
            ? srcProcesses.find((p) => p.typeId === srcProcId)
            : undefined;

        const dstProc =
            (targetProcessName && dstProcesses.find((p) => p.name === targetProcessName)) ||
            (srcProc && dstProcesses.find((p) => p.name === srcProc.name)) ||
            dstDefaultProc;

        console.log(`→ Creating ${sp.name} using process "${dstProc.name}"`);

        if (dryRun) {
            console.log(`   [DRY RUN] Would create "${sp.name}" (${VISIBILITY}).`);
            continue;
        }

        const opId = await queueCreateProject(
            effectiveTargetOrg!,
            sp.name,
            sp.description || '',
            dstProc.typeId,
            VISIBILITY
        );

        if (opId) {
            await waitForOperation(effectiveTargetOrg!, opId);
            console.log(`   ✅ Created: ${sp.name}`);
        }
    }
}

// Check if this file is being run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const command = process.argv[2];
    if (command === 'list') {
        listSourceProjects().catch((err) => {
            console.error('❌ Error:', err);
            process.exit(1);
        });
    } else {
        copyProjectsFromSourceToTarget().catch((err) => {
            console.error('❌ Error:', err);
            process.exit(1);
        });
    }
}
