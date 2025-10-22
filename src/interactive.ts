import inquirer from 'inquirer';
import { config } from './config.ts';

export interface ProjectConfig {
    sourceOrg: string;
    targetOrg: string;
    dryRun: boolean;
}

export async function getProjectConfig(): Promise<ProjectConfig> {
    const defaultSource = config.SOURCE_ORG || 'STMN-Group';
    const defaultTarget = config.TARGET_ORG || 'STMN-Group-TEST';

    const answers = await inquirer.prompt([
        {
            type: 'list',
            name: 'sourceOrg',
            message: 'Select the source organization:',
            choices: config.organizations,
            default: config.organizations.indexOf(defaultSource),
        },
        {
            type: 'list',
            name: 'targetOrg',
            message: 'Select the target organization:',
            choices: config.organizations,
            default: config.organizations.indexOf(defaultTarget),
        },
        {
            type: 'confirm',
            name: 'dryRun',
            message: 'Do you want to do a dry run first?',
            default: config.DRY_RUN,
        }
    ]);

    return {
        sourceOrg: answers.sourceOrg,
        targetOrg: answers.targetOrg,
        dryRun: answers.dryRun
    };
}

export interface OrgConfig {
    sourceOrg: string;
    targetOrg: string;
}

export async function getOrgConfig(): Promise<OrgConfig> {
    const defaultSource = config.SOURCE_ORG || 'STMN-Group';
    const defaultTarget = config.TARGET_ORG || 'STMN-Group-TEST';

    const answers = await inquirer.prompt([
        {
            type: 'list',
            name: 'sourceOrg',
            message: 'Select the source organization:',
            choices: config.organizations,
            default: config.organizations.indexOf(defaultSource),
        },
        {
            type: 'list',
            name: 'targetOrg',
            message: 'Select the target organization:',
            choices: config.organizations,
            default: config.organizations.indexOf(defaultTarget),
        }
    ]);

    return {
        sourceOrg: answers.sourceOrg,
        targetOrg: answers.targetOrg
    };
}
