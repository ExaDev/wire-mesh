// The native package ships types that TypeScript cannot resolve through its package.json "exports". Nothing here uses its exports: it is imported only so that a missing binary rejects (see loadHttp3Server in adapters/webtransport-transport.ts), so a bare declaration is all it needs.
declare module "@fails-components/webtransport-transport-http3-quiche";
