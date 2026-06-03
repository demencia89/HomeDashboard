export interface ComposeKeyValue {
  key: string;
  value: string;
}

export interface ComposePort {
  host: string;
  container: string;
  protocol: string;
}

export interface ComposeMount {
  host: string;
  container: string;
  mode: string;
}

export interface EditableComposeService {
  name: string;
  imageRepository: string;
  imageTag: string;
  containerName: string;
  networkMode: string;
  restart: string;
  privileged: boolean;
  memLimit: string;
  cpuShares: string;
  workingDir: string;
  ports: ComposePort[];
  volumes: ComposeMount[];
  environment: ComposeKeyValue[];
  devices: ComposeMount[];
  command: string[];
  capAdd: string[];
}

export type ComposeParseResult =
  | { ok: true; document: ComposeDocument; services: EditableComposeService[] }
  | { ok: false; error: string };

type ComposeScalar = string | number | boolean | null;
type ComposeValue = ComposeScalar | ComposeArray | ComposeObject;
interface ComposeArray extends Array<ComposeValue> {}
interface ComposeObject {
  [key: string]: ComposeValue;
}

type ComposeDocument = ComposeObject & { services?: ComposeObject };

interface YamlLine {
  indent: number;
  text: string;
}

const SIMPLE_KEY_PATTERN = /^([A-Za-z0-9_.-]+):(.*)$/;

export function parseDockerCompose(content: string): ComposeParseResult {
  try {
    const document = parseYamlObject(content);
    const servicesValue = document.services;

    if (!isRecord(servicesValue)) {
      return { ok: false, error: 'No services section found in this compose file.' };
    }

    const services = Object.entries(servicesValue)
      .filter(([, value]) => isRecord(value))
      .map(([name, value]) => toEditableService(name, value as ComposeObject));

    if (!services.length) {
      return { ok: false, error: 'No editable services found in this compose file.' };
    }

    return { ok: true, document, services };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Unable to parse this compose file.' };
  }
}

export function updateDockerComposeService(content: string, serviceName: string, service: EditableComposeService): string {
  const parsed = parseDockerCompose(content);

  if (!parsed.ok || !isRecord(parsed.document.services)) {
    throw new Error(parsed.ok ? 'No services section found in this compose file.' : parsed.error);
  }

  const existing = parsed.document.services[serviceName];

  if (!isRecord(existing)) {
    throw new Error(`Service "${serviceName}" was not found in this compose file.`);
  }

  parsed.document.services[serviceName] = fromEditableService(existing, service);
  return stringifyYaml(parsed.document) + '\n';
}

function parseYamlObject(content: string): ComposeDocument {
  const lines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\t/g, '  '))
    .map((line) => ({ indent: line.match(/^ */)?.[0].length ?? 0, text: stripYamlComment(line.trim()) }))
    .filter((line) => line.text.length > 0);

  if (!lines.length) {
    return {};
  }

  const [value, index] = parseBlock(lines, 0, lines[0]?.indent ?? 0);

  if (index < lines.length) {
    throw new Error('This compose file contains indentation that the form editor cannot read.');
  }

  if (!isRecord(value)) {
    throw new Error('This compose file does not look like a Compose mapping.');
  }

  return value;
}

function parseBlock(lines: YamlLine[], startIndex: number, indent: number): [ComposeValue, number] {
  const firstLine = lines[startIndex];

  if (!firstLine || firstLine.indent < indent) {
    return [{}, startIndex];
  }

  return firstLine.text.startsWith('- ')
    ? parseArrayBlock(lines, startIndex, firstLine.indent)
    : parseObjectBlock(lines, startIndex, firstLine.indent);
}

function parseObjectBlock(lines: YamlLine[], startIndex: number, indent: number): [ComposeObject, number] {
  const result: ComposeObject = {};
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];

    if (line.indent < indent) {
      break;
    }

    if (line.indent > indent) {
      throw new Error('This compose file contains indentation that the form editor cannot read.');
    }

    if (line.text.startsWith('- ')) {
      break;
    }

    const match = line.text.match(SIMPLE_KEY_PATTERN);

    if (!match) {
      throw new Error(`Unable to read compose line: ${line.text}`);
    }

    const key = unquoteYamlString(match[1].trim());
    const rawValue = match[2].trim();

    if (isBlockScalarMarker(rawValue)) {
      const [blockValue, nextIndex] = parseBlockScalar(lines, index + 1, indent, rawValue);
      result[key] = blockValue;
      index = nextIndex;
      continue;
    }

    if (rawValue) {
      result[key] = parseScalar(rawValue);
      index += 1;
      continue;
    }

    const nextLine = lines[index + 1];

    if (!nextLine || nextLine.indent <= indent) {
      result[key] = {};
      index += 1;
      continue;
    }

    const [nested, nextIndex] = parseBlock(lines, index + 1, nextLine.indent);
    result[key] = nested;
    index = nextIndex;
  }

  return [result, index];
}

function isBlockScalarMarker(value: string): boolean {
  return /^[|>][+-]?$/.test(value);
}

function parseBlockScalar(lines: YamlLine[], startIndex: number, parentIndent: number, marker: string): [string, number] {
  const blockLines: YamlLine[] = [];
  let index = startIndex;

  while (index < lines.length && lines[index].indent > parentIndent) {
    blockLines.push(lines[index]);
    index += 1;
  }

  if (!blockLines.length) {
    return ['', index];
  }

  const contentIndent = Math.min(...blockLines.map((line) => line.indent));
  const values = blockLines.map((line) => ' '.repeat(Math.max(0, line.indent - contentIndent)) + line.text);

  return [marker.startsWith('>') ? values.join(' ') : values.join('\n'), index];
}

function parseArrayBlock(lines: YamlLine[], startIndex: number, indent: number): [ComposeValue[], number] {
  const result: ComposeValue[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];

    if (line.indent < indent) {
      break;
    }

    if (line.indent > indent) {
      throw new Error('This compose file contains indentation that the form editor cannot read.');
    }

    if (!line.text.startsWith('- ')) {
      break;
    }

    const rawValue = line.text.slice(2).trim();

    if (!rawValue) {
      const nextLine = lines[index + 1];
      if (!nextLine || nextLine.indent <= indent) {
        result.push({});
        index += 1;
        continue;
      }

      const [nested, nextIndex] = parseBlock(lines, index + 1, nextLine.indent);
      result.push(nested);
      index = nextIndex;
      continue;
    }

    const inlineMatch = rawValue.match(SIMPLE_KEY_PATTERN);
    const nextLine = lines[index + 1];

    if (inlineMatch && nextLine?.indent && nextLine.indent > indent) {
      const item: ComposeObject = {
        [unquoteYamlString(inlineMatch[1].trim())]: inlineMatch[2].trim() ? parseScalar(inlineMatch[2].trim()) : {},
      };
      const [nested, nextIndex] = parseObjectBlock(lines, index + 1, nextLine.indent);
      result.push({ ...item, ...nested });
      index = nextIndex;
      continue;
    }

    result.push(parseScalar(rawValue));
    index += 1;
  }

  return [result, index];
}

function stripYamlComment(value: string): string {
  let quote: string | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];

    if ((char === '"' || char === "'") && previous !== '\\') {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }

    if (char === '#' && !quote && (index === 0 || /\s/.test(previous))) {
      return value.slice(0, index).trimEnd();
    }
  }

  return value;
}

function parseScalar(value: string): ComposeValue {
  const trimmed = value.trim();

  if (trimmed === 'true') {
    return true;
  }

  if (trimmed === 'false') {
    return false;
  }

  if (trimmed === 'null' || trimmed === '~') {
    return null;
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return unquoteYamlString(trimmed);
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseInlineArray(trimmed);
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  return trimmed;
}

function parseInlineArray(value: string): ComposeValue[] {
  const body = value.slice(1, -1).trim();

  if (!body) {
    return [];
  }

  return splitRespectingQuotes(body, ',').map((item) => parseScalar(item.trim()));
}

function splitRespectingQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let quote: string | undefined;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];

    if ((char === '"' || char === "'") && previous !== '\\') {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }

    if (char === separator && !quote) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(value.slice(start));
  return parts;
}

function unquoteYamlString(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  return trimmed;
}

function toEditableService(name: string, value: ComposeObject): EditableComposeService {
  const image = splitDockerImage(readString(value.image));

  return {
    name,
    imageRepository: image.repository,
    imageTag: image.tag,
    containerName: readString(value.container_name),
    networkMode: readNetworkMode(value),
    restart: readString(value.restart),
    privileged: value.privileged === true,
    memLimit: readString(value.mem_limit),
    cpuShares: readString(value.cpu_shares),
    workingDir: readString(value.working_dir),
    ports: readPorts(value.ports),
    volumes: readMounts(value.volumes),
    environment: readEnvironment(value.environment),
    devices: readMounts(value.devices),
    command: readStringArray(value.command),
    capAdd: readStringArray(value.cap_add),
  };
}

function fromEditableService(existing: ComposeObject, service: EditableComposeService): ComposeObject {
  const next: ComposeObject = { ...existing };
  setOptionalString(next, 'image', joinDockerImage(service.imageRepository, service.imageTag));
  setOptionalString(next, 'container_name', service.containerName);
  setOptionalString(next, 'network_mode', service.networkMode);
  if (service.networkMode) {
    delete next.networks;
  }
  setOptionalString(next, 'restart', service.restart);
  setOptionalString(next, 'mem_limit', service.memLimit);
  setOptionalString(next, 'working_dir', service.workingDir);
  setOptionalNumberOrString(next, 'cpu_shares', service.cpuShares);

  if (service.privileged) {
    next.privileged = true;
  } else {
    delete next.privileged;
  }

  setOptionalArray(next, 'ports', service.ports.map(formatPort).filter(Boolean));
  setOptionalArray(next, 'volumes', service.volumes.map(formatMount).filter(Boolean));
  setOptionalArray(next, 'devices', service.devices.map(formatMount).filter(Boolean));
  setOptionalArray(next, 'cap_add', service.capAdd.map((capability) => capability.trim()).filter(Boolean));
  setOptionalArray(next, 'command', service.command.map((item) => item.trim()).filter(Boolean));

  const environment = Object.fromEntries(
    service.environment
      .map((entry) => [entry.key.trim(), entry.value.trim()])
      .filter(([key]) => key),
  );

  if (Object.keys(environment).length) {
    next.environment = environment;
  } else {
    delete next.environment;
  }

  return next;
}

function splitDockerImage(value: string): { repository: string; tag: string } {
  const digestIndex = value.indexOf('@');
  const imageWithoutDigest = digestIndex === -1 ? value : value.slice(0, digestIndex);
  const lastSlashIndex = imageWithoutDigest.lastIndexOf('/');
  const lastColonIndex = imageWithoutDigest.lastIndexOf(':');

  if (lastColonIndex > lastSlashIndex) {
    return {
      repository: value.slice(0, lastColonIndex),
      tag: value.slice(lastColonIndex + 1),
    };
  }

  return { repository: value, tag: '' };
}

function joinDockerImage(repository: string, tag: string): string {
  const cleanRepository = repository.trim();
  const cleanTag = tag.trim();

  if (!cleanRepository) {
    return '';
  }

  return cleanTag ? `${cleanRepository}:${cleanTag}` : cleanRepository;
}

function readNetworkMode(value: ComposeObject): string {
  return readString(value.network_mode);
}

function readPorts(value: ComposeValue | undefined): ComposePort[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => {
    if (isRecord(item)) {
      return {
        host: readString(item.published),
        container: readString(item.target),
        protocol: (readString(item.protocol) || 'TCP').toUpperCase(),
      };
    }

    const text = readString(item);
    const [portText, protocol = 'TCP'] = text.split('/');
    const parts = portText.split(':');

    if (parts.length >= 2) {
      return {
        host: parts[parts.length - 2] ?? '',
        container: parts[parts.length - 1] ?? '',
        protocol: protocol.toUpperCase(),
      };
    }

    return { host: '', container: parts[0] ?? '', protocol: protocol.toUpperCase() };
  });
}

function readMounts(value: ComposeValue | undefined): ComposeMount[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => {
    if (isRecord(item)) {
      return {
        host: readString(item.source),
        container: readString(item.target),
        mode: readString(item.mode),
      };
    }

    const parts = readString(item).split(':');
    return {
      host: parts[0] ?? '',
      container: parts[1] ?? '',
      mode: parts.slice(2).join(':'),
    };
  });
}

function readEnvironment(value: ComposeValue | undefined): ComposeKeyValue[] {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const text = readString(item);
      const equalsIndex = text.indexOf('=');

      if (equalsIndex === -1) {
        return { key: text, value: '' };
      }

      return { key: text.slice(0, equalsIndex), value: text.slice(equalsIndex + 1) };
    });
  }

  if (isRecord(value)) {
    return Object.entries(value).map(([key, entryValue]) => ({ key, value: readString(entryValue) }));
  }

  return [];
}

function readStringArray(value: ComposeValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => readString(item));
  }

  const text = readString(value);
  return text ? [text] : [];
}

function readString(value: ComposeValue | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return '';
}

function setOptionalString(target: ComposeObject, key: string, value: string): void {
  const trimmed = value.trim();

  if (trimmed) {
    target[key] = trimmed;
  } else {
    delete target[key];
  }
}

function setOptionalNumberOrString(target: ComposeObject, key: string, value: string): void {
  const trimmed = value.trim();

  if (!trimmed) {
    delete target[key];
    return;
  }

  target[key] = /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function setOptionalArray(target: ComposeObject, key: string, value: string[]): void {
  if (value.length) {
    target[key] = value;
  } else {
    delete target[key];
  }
}

function formatPort(port: ComposePort): string {
  const host = port.host.trim();
  const container = port.container.trim();
  const protocol = port.protocol.trim().toLowerCase();

  if (!container) {
    return '';
  }

  const mapping = host ? `${host}:${container}` : container;
  return protocol && protocol !== 'tcp' ? `${mapping}/${protocol}` : mapping;
}

function formatMount(mount: ComposeMount): string {
  const host = mount.host.trim();
  const container = mount.container.trim();
  const mode = mount.mode.trim();

  if (!host || !container) {
    return '';
  }

  return mode ? `${host}:${container}:${mode}` : `${host}:${container}`;
}

function stringifyYaml(value: ComposeValue, indent = 0): string {
  if (Array.isArray(value)) {
    return value.map((item) => stringifyYamlArrayItem(item, indent)).join('\n');
  }

  if (isRecord(value)) {
    return Object.entries(value).map(([key, entryValue]) => {
      if (Array.isArray(entryValue)) {
        return entryValue.length
          ? `${' '.repeat(indent)}${key}:\n${stringifyYaml(entryValue, indent + 2)}`
          : `${' '.repeat(indent)}${key}: []`;
      }

      if (isRecord(entryValue)) {
        return Object.keys(entryValue).length
          ? `${' '.repeat(indent)}${key}:\n${stringifyYaml(entryValue, indent + 2)}`
          : `${' '.repeat(indent)}${key}: {}`;
      }

      return `${' '.repeat(indent)}${key}: ${formatScalar(entryValue)}`;
    }).join('\n');
  }

  return `${' '.repeat(indent)}${formatScalar(value)}`;
}

function stringifyYamlArrayItem(value: ComposeValue, indent: number): string {
  const prefix = `${' '.repeat(indent)}-`;

  if (Array.isArray(value)) {
    return `${prefix}\n${stringifyYaml(value, indent + 2)}`;
  }

  if (isRecord(value)) {
    return Object.keys(value).length
      ? `${prefix}\n${stringifyYaml(value, indent + 2)}`
      : `${prefix} {}`;
  }

  return `${prefix} ${formatScalar(value)}`;
}

function formatScalar(value: ComposeScalar): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (!value) {
    return '""';
  }

  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value) && !/^(true|false|null|~)$/i.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function isRecord(value: unknown): value is ComposeObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
