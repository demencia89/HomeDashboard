export function joinPath(directory: string, name: string): string {
  if (!directory || directory === '.') {
    return name;
  }

  if (directory === '/' || directory.endsWith('/')) {
    return directory + name;
  }

  return directory + '/' + name;
}

export function parentPath(value: string): string {
  const normalized = value.replace(/\/+$/g, '');

  if (!normalized || normalized === '.' || normalized === '/') {
    return '.';
  }

  const index = normalized.lastIndexOf('/');

  if (index <= 0) {
    return '.';
  }

  return normalized.slice(0, index);
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Unable to read file.'));
    reader.readAsDataURL(file);
  });
}
