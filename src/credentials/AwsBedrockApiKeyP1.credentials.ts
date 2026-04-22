import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class AwsBedrockApiKeyP1 implements ICredentialType {
	name = 'awsBedrockApiKeyP1';
	displayName = 'AWS Bedrock API Key (P1)';
	documentationUrl = 'https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html';
	properties: INodeProperties[] = [
		{
			displayName: 'Bedrock API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Bedrock API key (starts with brk-)',
		},
		{
			displayName: 'Region',
			name: 'region',
			type: 'options',
			options: [
				{ name: 'EU (Frankfurt) — eu-central-1', value: 'eu-central-1' },
				{ name: 'EU (Ireland) — eu-west-1',      value: 'eu-west-1'    },
				{ name: 'EU (Stockholm) — eu-north-1',   value: 'eu-north-1'   },
				{ name: 'US East (N. Virginia) — us-east-1', value: 'us-east-1' },
				{ name: 'US West (Oregon) — us-west-2',  value: 'us-west-2'    },
			],
			default: 'eu-central-1',
			required: true,
		},
	];

	authenticate = {
		type: 'generic' as const,
		properties: {},
	};

	test: ICredentialType['test'] = {
		request: {
			method: 'GET' as const,
			baseURL: '=https://bedrock.{{$credentials.region}}.amazonaws.com',
			url: '/foundation-models',
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};
}
