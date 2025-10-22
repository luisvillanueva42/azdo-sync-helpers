import { config } from './config.ts';

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
    if (!config.AZDO_PAT) {
        return {
            hasAccess: false,
            error: 'Missing AZDO_PAT. Please set it in your environment or .env file.'
        };
    }

    const [sourceAccess, targetAccess] = await Promise.all([
        checkOrgAccess(sourceOrg),
        checkOrgAccess(targetOrg)
    ]);

    if (!sourceAccess.hasAccess) {
        return {
            hasAccess: false,
            error: sourceAccess.error
        };
    }

    if (!targetAccess.hasAccess) {
        return {
            hasAccess: false,
            error: targetAccess.error
        };
    }

    return { hasAccess: true, error: undefined };
}