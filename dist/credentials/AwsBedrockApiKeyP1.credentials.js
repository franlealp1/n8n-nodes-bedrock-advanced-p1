"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/credentials/AwsBedrockApiKeyP1.credentials.ts
var AwsBedrockApiKeyP1_credentials_exports = {};
__export(AwsBedrockApiKeyP1_credentials_exports, {
  AwsBedrockApiKeyP1: () => AwsBedrockApiKeyP1
});
module.exports = __toCommonJS(AwsBedrockApiKeyP1_credentials_exports);
var AwsBedrockApiKeyP1 = class {
  constructor() {
    this.name = "awsBedrockApiKeyP1";
    this.displayName = "AWS Bedrock API Key (P1)";
    this.documentationUrl = "https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html";
    this.properties = [
      {
        displayName: "Bedrock API Key",
        name: "apiKey",
        type: "string",
        typeOptions: { password: true },
        default: "",
        required: true,
        description: "Bedrock API key (starts with brk-)"
      },
      {
        displayName: "Region",
        name: "region",
        type: "options",
        options: [
          { name: "EU (Frankfurt) \u2014 eu-central-1", value: "eu-central-1" },
          { name: "EU (Ireland) \u2014 eu-west-1", value: "eu-west-1" },
          { name: "EU (Stockholm) \u2014 eu-north-1", value: "eu-north-1" },
          { name: "US East (N. Virginia) \u2014 us-east-1", value: "us-east-1" },
          { name: "US West (Oregon) \u2014 us-west-2", value: "us-west-2" }
        ],
        default: "eu-central-1",
        required: true
      }
    ];
    this.authenticate = {
      type: "generic",
      properties: {
        headers: {
          Authorization: "=Bearer {{$credentials.apiKey}}"
        }
      }
    };
    this.test = {
      request: {
        method: "GET",
        baseURL: "=https://bedrock.{{$credentials.region}}.amazonaws.com",
        url: "/foundation-models",
        headers: {
          Authorization: "=Bearer {{$credentials.apiKey}}"
        }
      }
    };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AwsBedrockApiKeyP1
});
//# sourceMappingURL=AwsBedrockApiKeyP1.credentials.js.map
