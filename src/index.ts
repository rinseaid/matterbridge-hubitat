import {
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  bridgedNode,
  contactSensor,
  coverDevice,
  doorLockDevice,
  humiditySensor,
  occupancySensor,
  onOffOutlet,
  onOffSwitch,
  powerSource,
  smokeCoAlarm,
  temperatureSensor,
  waterLeakDetector,
} from 'matterbridge';
import type { PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import type { AnsiLogger } from 'node-ansi-logger';
import WebSocket from 'ws';
import { get } from 'node:http';

// Hubitat types

interface HubitatDevice {
  id: string;
  name: string;
  label: string;
  type: string;
  room: string;
  attributes: { name: string; currentValue: unknown; dataType: string; values?: string[]; unit?: string }[];
  capabilities: (string | { attributes: { name: string; dataType: string | null }[] })[];
  commands: string[];
}

interface HubitatEvent {
  deviceId: string | null;
  name: string;
  value: string;
  displayName?: string;
  unit?: string | null;
}

interface PluginConfig extends PlatformConfig {
  host: string;
  makerApiId: number;
  accessToken: string;
  devices?: number[];
  temperatureUnit?: string;
}

// Helpers

function caps(dev: HubitatDevice): Set<string> {
  return new Set(dev.capabilities.filter((c): c is string => typeof c === 'string'));
}

function attr(dev: HubitatDevice, name: string): unknown {
  return dev.attributes.find((a) => a.name === name)?.currentValue ?? null;
}

function hasAttr(dev: HubitatDevice, name: string): boolean {
  return dev.attributes.some((a) => a.name === name);
}

function makerGet(cfg: PluginConfig, path: string): Promise<string> {
  const url = `http://${cfg.host}/apps/api/${cfg.makerApiId}/${path}?access_token=${cfg.accessToken}`;
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let data = '';
      res.on('data', (chunk: string) => (data += chunk));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function toC(f: number): number {
  return (f - 32) * (5 / 9);
}

// Device entry tracks the endpoint and what types it exposes

type DeviceEntry = { dev: HubitatDevice; ep: MatterbridgeEndpoint; types: string[] };

// Plugin

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): HubitatPlatform {
  return new HubitatPlatform(matterbridge, log, config);
}

export class HubitatPlatform extends MatterbridgeDynamicPlatform {
  private devices = new Map<string, DeviceEntry>();
  private ws: WebSocket | null = null;
  private reconnectDelay = 5000;
  private stopping = false;

  override async onStart(): Promise<void> {
    const cfg = this.config as PluginConfig;
    if (!cfg.host || !cfg.makerApiId || !cfg.accessToken) {
      this.log.error('Missing required config: host, makerApiId, accessToken');
      return;
    }

    const ids = cfg.devices ?? [];
    this.log.info(`Fetching ${ids.length} devices from Hubitat at ${cfg.host}`);

    for (const id of ids) {
      try {
        const raw = await makerGet(cfg, `devices/${id}`);
        const dev: HubitatDevice = JSON.parse(raw);
        await this.register(dev);
        await new Promise((r) => setTimeout(r, 200));
      } catch (e) {
        this.log.error(`Failed to load device ${id}: ${e}`);
      }
    }

    this.log.info(`Registered ${this.devices.size} devices`);
    this.connectWs();
  }

  override async onConfigure(): Promise<void> {
    for (const entry of this.devices.values()) {
      this.setState(entry);
    }
    this.log.info('Published initial state');
  }

  override async onShutdown(): Promise<void> {
    this.stopping = true;
    this.ws?.close();
    this.ws = null;
    await this.unregisterAllDevices();
    this.devices.clear();
  }

  // Device registration

  private async register(dev: HubitatDevice): Promise<void> {
    const c = caps(dev);
    const types: string[] = [];
    const deviceTypes = [bridgedNode];

    if (c.has('Lock')) {
      deviceTypes.push(doorLockDevice);
      types.push('lock');
    } else if (c.has('WindowShade') || c.has('WindowBlind')) {
      deviceTypes.push(coverDevice);
      types.push('cover');
    } else if (c.has('Switch')) {
      deviceTypes.push(/switch/i.test(dev.label) ? onOffSwitch : onOffOutlet);
      types.push('switch');
    }

    if (hasAttr(dev, 'motion')) {
      deviceTypes.push(occupancySensor);
      types.push('motion');
    }
    if (hasAttr(dev, 'temperature')) {
      deviceTypes.push(temperatureSensor);
      types.push('temperature');
    }
    if (hasAttr(dev, 'humidity')) {
      deviceTypes.push(humiditySensor);
      types.push('humidity');
    }
    if (hasAttr(dev, 'contact')) {
      deviceTypes.push(contactSensor);
      types.push('contact');
    }
    if (hasAttr(dev, 'water')) {
      deviceTypes.push(waterLeakDetector);
      types.push('water');
    }
    if (hasAttr(dev, 'smoke') || hasAttr(dev, 'carbonMonoxide')) {
      deviceTypes.push(smokeCoAlarm);
      types.push('smoke');
    }
    if (hasAttr(dev, 'battery')) {
      deviceTypes.push(powerSource);
    }

    if (types.length === 0) {
      this.log.warn(`Skipping ${dev.label} (${dev.id}): no supported capabilities`);
      return;
    }

    const ep = new MatterbridgeEndpoint(deviceTypes as [typeof bridgedNode, ...typeof deviceTypes], { id: `hubitat-${dev.id}` }, false);

    ep.createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(dev.label, `hubitat-${dev.id}`, 0xfff1, 'Hubitat', dev.type);

    if (types.includes('switch')) {
      ep.createDefaultOnOffClusterServer(attr(dev, 'switch') === 'on');
      ep.addCommandHandler('on', async () => this.cmd(dev.id, 'on'));
      ep.addCommandHandler('off', async () => this.cmd(dev.id, 'off'));
    }

    if (types.includes('cover')) {
      ep.createDefaultWindowCoveringClusterServer();
      ep.addCommandHandler('upOrOpen', async () => this.cmd(dev.id, 'open'));
      ep.addCommandHandler('downOrClose', async () => this.cmd(dev.id, 'close'));
      ep.addCommandHandler('stopMotion', async () => this.cmd(dev.id, 'pause'));
      ep.addCommandHandler('goToLiftPercentage', async ({ request }) => {
        const pct = (request as { liftPercent100thsValue: number }).liftPercent100thsValue / 100;
        await this.cmd(dev.id, 'setPosition', String(100 - pct));
      });
    }

    if (types.includes('lock')) {
      ep.createDefaultDoorLockClusterServer();
      ep.addCommandHandler('lockDoor', async () => this.cmd(dev.id, 'lock'));
      ep.addCommandHandler('unlockDoor', async () => this.cmd(dev.id, 'unlock'));
    }

    if (types.includes('motion')) {
      ep.createDefaultOccupancySensingClusterServer(attr(dev, 'motion') === 'active');
    }

    if (types.includes('temperature')) {
      const cfg = this.config as PluginConfig;
      const raw = Number(attr(dev, 'temperature')) || 0;
      const celsius = cfg.temperatureUnit === 'F' ? toC(raw) : raw;
      ep.createDefaultTemperatureMeasurementClusterServer(Math.round(celsius * 100));
    }

    if (types.includes('humidity')) {
      ep.createDefaultRelativeHumidityMeasurementClusterServer(Math.round((Number(attr(dev, 'humidity')) || 0) * 100));
    }

    if (types.includes('contact')) {
      ep.createDefaultBooleanStateClusterServer(attr(dev, 'contact') !== 'open');
    }

    if (types.includes('water')) {
      ep.createDefaultBooleanStateClusterServer(attr(dev, 'water') !== 'wet');
    }

    if (types.includes('smoke')) {
      ep.createSmokeOnlySmokeCOAlarmClusterServer();
    }

    if (hasAttr(dev, 'battery')) {
      const bat = Number(attr(dev, 'battery')) || 0;
      ep.createDefaultPowerSourceReplaceableBatteryClusterServer(bat * 2, undefined, bat);
    }

    ep.addRequiredClusterServers();
    await this.registerDevice(ep);

    this.devices.set(dev.id, { dev, ep, types });
    this.log.info(`${dev.label} (${dev.id}): [${types.join(', ')}]`);
  }

  // State publishing

  private setState(entry: DeviceEntry): void {
    const { dev, ep, types } = entry;
    const cfg = this.config as PluginConfig;

    if (types.includes('switch')) {
      ep.setAttribute('onOff', 'onOff', attr(dev, 'switch') === 'on');
    }
    if (types.includes('cover')) {
      const pos = Number(attr(dev, 'position')) || 0;
      ep.setWindowCoveringTargetAndCurrentPosition((100 - pos) * 100);
    }
    if (types.includes('lock')) {
      ep.setAttribute('doorLock', 'lockState', attr(dev, 'lock') === 'locked' ? 1 : 2);
    }
    if (types.includes('motion')) {
      ep.setAttribute('occupancySensing', 'occupancy', { occupied: attr(dev, 'motion') === 'active' });
    }
    if (types.includes('temperature')) {
      const raw = Number(attr(dev, 'temperature')) || 0;
      const celsius = cfg.temperatureUnit === 'F' ? toC(raw) : raw;
      ep.setAttribute('temperatureMeasurement', 'measuredValue', Math.round(celsius * 100));
    }
    if (types.includes('humidity')) {
      ep.setAttribute('relativeHumidityMeasurement', 'measuredValue', Math.round((Number(attr(dev, 'humidity')) || 0) * 100));
    }
    if (types.includes('contact')) {
      ep.setAttribute('booleanState', 'stateValue', attr(dev, 'contact') === 'open');
    }
    if (types.includes('water')) {
      ep.setAttribute('booleanState', 'stateValue', attr(dev, 'water') === 'wet');
    }
    if (types.includes('smoke')) {
      const detected = attr(dev, 'smoke') === 'detected';
      ep.setAttribute('smokeCoAlarm', 'smokeState', detected ? 1 : 0);
    }
    if (hasAttr(dev, 'battery')) {
      ep.setAttribute('powerSource', 'batPercentRemaining', (Number(attr(dev, 'battery')) || 0) * 2);
    }
  }

  // Event handling from EventSocket

  private handleEvent(evt: HubitatEvent): void {
    if (!evt.deviceId) return;
    const entry = this.devices.get(evt.deviceId);
    if (!entry) return;

    const a = entry.dev.attributes.find((a) => a.name === evt.name);
    if (a) a.currentValue = evt.value;

    const { ep, types } = entry;
    const cfg = this.config as PluginConfig;

    switch (evt.name) {
      case 'switch':
        if (types.includes('switch')) ep.setAttribute('onOff', 'onOff', evt.value === 'on');
        break;
      case 'position':
        if (types.includes('cover')) {
          const pos = Number(evt.value) || 0;
          ep.setWindowCoveringTargetAndCurrentPosition((100 - pos) * 100);
        }
        break;
      case 'lock':
        if (types.includes('lock')) ep.setAttribute('doorLock', 'lockState', evt.value === 'locked' ? 1 : 2);
        break;
      case 'motion':
        if (types.includes('motion')) ep.setAttribute('occupancySensing', 'occupancy', { occupied: evt.value === 'active' });
        break;
      case 'temperature': {
        if (!types.includes('temperature')) break;
        const raw = Number(evt.value) || 0;
        const celsius = cfg.temperatureUnit === 'F' ? toC(raw) : raw;
        ep.setAttribute('temperatureMeasurement', 'measuredValue', Math.round(celsius * 100));
        break;
      }
      case 'humidity':
        if (types.includes('humidity')) ep.setAttribute('relativeHumidityMeasurement', 'measuredValue', Math.round((Number(evt.value) || 0) * 100));
        break;
      case 'contact':
        if (types.includes('contact')) ep.setAttribute('booleanState', 'stateValue', evt.value === 'open');
        break;
      case 'water':
        if (types.includes('water')) ep.setAttribute('booleanState', 'stateValue', evt.value === 'wet');
        break;
      case 'smoke':
        if (types.includes('smoke')) ep.setAttribute('smokeCoAlarm', 'smokeState', evt.value === 'detected' ? 1 : 0);
        break;
      case 'carbonMonoxide':
        if (types.includes('smoke')) ep.setAttribute('smokeCoAlarm', 'coState', evt.value === 'detected' ? 1 : 0);
        break;
      case 'battery':
        ep.setAttribute('powerSource', 'batPercentRemaining', (Number(evt.value) || 0) * 2);
        break;
    }

    this.log.debug(`${entry.dev.label}: ${evt.name}=${evt.value}`);
  }

  // WebSocket connection to Hubitat EventSocket

  private connectWs(): void {
    if (this.stopping) return;
    const cfg = this.config as PluginConfig;
    const url = `ws://${cfg.host}/eventsocket`;
    this.log.info(`Connecting to ${url}`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.log.info('EventSocket connected');
      this.reconnectDelay = 5000;
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        this.handleEvent(JSON.parse(data.toString()));
      } catch (e) {
        this.log.warn(`Bad EventSocket message: ${e}`);
      }
    });

    this.ws.on('close', () => {
      this.log.warn('EventSocket disconnected');
      this.reconnect();
    });

    this.ws.on('error', (err: Error) => {
      this.log.error(`EventSocket error: ${err.message}`);
      this.ws?.close();
    });
  }

  private reconnect(): void {
    if (this.stopping) return;
    this.log.info(`Reconnecting in ${this.reconnectDelay / 1000}s`);
    setTimeout(() => this.connectWs(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
  }

  // Send command to Hubitat via Maker API

  private async cmd(deviceId: string, command: string, value?: string): Promise<void> {
    const cfg = this.config as PluginConfig;
    const path = value ? `devices/${deviceId}/${command}/${value}` : `devices/${deviceId}/${command}`;
    try {
      await makerGet(cfg, path);
      this.log.debug(`Command: ${deviceId} ${command} ${value ?? ''}`);
    } catch (e) {
      this.log.error(`Command failed: ${deviceId} ${command}: ${e}`);
    }
  }
}
