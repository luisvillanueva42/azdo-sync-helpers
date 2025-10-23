import { config } from './config.ts';
import inquirer from 'inquirer';
import { writeFileSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export interface AuthResult {
    hasAccess: boolean;
    error: string | undefined;
}

export async function checkOrgAccess(org: string): Promise<AuthResult> {
    const API_VER = '7.1';
    const AUTH = 'Basic ' + Buffer.from(':' + config.AZDO_PAT).toString('base64');
    const headers = { Authorization: AUTH };

    try {
        // Try to list processes - this requires proper org access
        const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes`);
        url.searchParams.set('api-version', API_VER);

        const res = await fetch(url, { headers });
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                return {
                    hasAccess: false,
                    error: `No access to organization ${org}. Status: ${res.status}`
                };
            }
            const text = await res.text();
            return {
                hasAccess: false,
                error: `Error accessing ${org}: ${res.status} ${text}`
            };
        }

        return { hasAccess: true, error: undefined };
    } catch (err) {
        return {
            hasAccess: false,
            error: `Network error accessing ${org}: ${err instanceof Error ? err.message : String(err)}`
        };
    }
}

export async function validateAccess(sourceOrg: string, targetOrg: string): Promise<AuthResult> {
    let pat = config.AZDO_PAT;
    let allOrgs = config.organizations || [];
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

    // Test PAT against all orgs
    let failedOrg = null;
    for (const org of [sourceOrg, targetOrg, ...allOrgs]) {
        if (!org) continue;
        const API_VER = '7.1';
        const AUTH = 'Basic ' + Buffer.from(':' + pat).toString('base64');
        const headers = { Authorization: AUTH };
        try {
            const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes`);
            url.searchParams.set('api-version', API_VER);
            const res = await fetch(url, { headers });
            if (!res.ok) {
                failedOrg = org;
                break;
            }
        } catch {
            failedOrg = org;
            break;
        }
    }

    if (failedOrg) {
        return {
            hasAccess: false,
            error: `PAT is invalid or does not have access to organization: ${failedOrg}`
        };
    }

    // Save PAT to config.ts if it was newly provided
    if (pat !== config.AZDO_PAT && pat) {
        // Update config.ts file
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const configPath = join(__dirname, 'config.ts');
        let configText = readFileSync(configPath, 'utf-8');
        configText = configText.replace(/AZDO_PAT:\s*['\"][^'\"]*['\"]/, `AZDO_PAT: '${pat}'`);
        writeFileSync(configPath, configText);
        config.AZDO_PAT = pat;
    }

    return { hasAccess: true, error: undefined };
}