# Security policy

## Scope

This project routes requests but does not provide model hosting, billing or a public gateway. The core does not read environment variables, log content or send telemetry automatically.

## Reporting

Please do not open a public issue for a suspected vulnerability. Email the repository owner through the GitHub security advisory flow or the private contact configured in the repository. Include a reproduction, affected package/version and impact. Do not include real prompts, provider keys or customer data.

## Operational guidance

- pass credentials explicitly to adapters;
- use HTTPS and endpoint allowlists for custom adapters;
- keep the example proxy on localhost or configure an internal token;
- restrict CORS and payload size;
- do not paste provider keys into the hosted playground;
- review data residency, retention and provider terms for the actual workload;
- treat catalog prices, capabilities and observed quality as staleable data;
- keep shadow execution disabled unless additional cost and privacy have been approved.

Security fixes are released with a changelog entry. See the repository workflows for dependency review, CodeQL and secret scanning.
