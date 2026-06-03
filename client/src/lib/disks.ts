import type { DiskMetric } from '../types';

export function findDiskByMount(disks: DiskMetric[], mount: string | undefined): DiskMetric | undefined {
  if (!mount) {
    return undefined;
  }

  return disks.find((disk) => disk.mount === mount);
}

export function isUserMountedDisk(disk: DiskMetric): boolean {
  const mount = disk.mount.replace(/\/+$/g, '') || '/';
  return mount === '/mnt' || mount.startsWith('/mnt/') || mount === '/media' || mount.startsWith('/media/') || mount.startsWith('/run/media/');
}
