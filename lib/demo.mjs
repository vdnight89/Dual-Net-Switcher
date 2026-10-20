export class DemoPlatform {
  constructor() { this.owned = { routes: [], nrpt: [], metrics: [] }; }
  async inspect() {
    return { admin: true, recoveryRequired: false, routes: this.owned.routes, nrpt: this.owned.nrpt, owned: structuredClone(this.owned), adapters: [
      { id: 'demo-ethernet', index: 12, name: '以太网 2', description: '演练 · 有线网络', kind: 'ethernet', up: true, networkName: 'Office-LAN', addresses: ['192.168.1.23'], prefixes: ['192.168.1.0/24'], gateway: '192.168.1.1', dns: ['192.168.1.1'], metric: 25, automaticMetric: true },
      { id: 'demo-wifi', index: 7, name: 'WLAN', description: '演练 · 无线网络', kind: 'wifi', up: true, networkName: 'Port-WiFi', addresses: ['10.20.0.18'], prefixes: ['10.20.0.0/24'], gateway: '10.20.0.1', dns: ['10.20.0.2'], metric: 50, automaticMetric: true }
    ] };
  }
  async resolve({ host }) {
    if (host.includes('invalid')) throw new Error('演练：DNS 未返回记录');
    return [{ address: host.includes('git') ? '10.20.2.80' : '10.20.1.55', ttl: 600 }];
  }
  async apply(plan) { this.owned = structuredClone({ routes: plan.routes, nrpt: plan.nrpt, metrics: plan.metrics }); return { simulated: true }; }
  async reset() { this.owned = { routes: [], nrpt: [], metrics: [] }; return { simulated: true }; }
  async setStartup() { return { simulated: true }; }
}
export const demoConfig = { settings: { external_nic_id: 'demo-ethernet', internal_nic_id: 'demo-wifi', auto_sync_interval_mins: 10 }, rules: [
  { id: 'demo-1', type: 'CIDR', target: '10.0.0.0/8', network: 'internal', remark: '公司 A 业务网络', enabled: true },
  { id: 'demo-2', type: 'Domain', target: 'oa.company-a.com', network: 'internal', remark: '内网 OA 系统', enabled: true },
  { id: 'demo-3', type: 'Domain', target: 'git.company-a.com', network: 'internal', remark: '代码仓库', enabled: true },
  { id: 'demo-4', type: 'SingleIP', target: '192.168.1.100', network: 'external', remark: '公司 B 跳板机', enabled: true },
  { id: 'demo-5', type: 'CIDR', target: '172.18.0.0/16', network: 'internal', remark: '研发测试环境', enabled: false }
] };
