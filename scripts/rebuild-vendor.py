#!/usr/bin/env python3
"""Kiểm integrity npm và tái tạo tarball peer metadata; --write để lưu vào vendor/."""
import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--write', action='store_true')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
manifest = json.loads((repo / 'manifests/current/package.json').read_text())
# Phiên bản Pi đã ghim; tarball chỉ bổ sung đúng phiên bản này vào peer range upstream.
pi_version = manifest['dependencies']['@earendil-works/pi-coding-agent']
for name, spec in manifest['piPlatform']['localPackages'].items():
    with tempfile.TemporaryDirectory(prefix='pi-vendor-') as temporary:
        root = Path(temporary)
        payload = subprocess.check_output(['curl', '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--max-time', '60', spec['upstreamTarball']])
        algorithm, expected = spec['upstreamIntegrity'].split('-', 1)
        actual = base64.b64encode(hashlib.new(algorithm, payload).digest()).decode()
        if actual != expected:
            raise RuntimeError(f'Integrity upstream không khớp: {name}')
        archive = root / 'upstream.tgz'
        archive.write_bytes(payload)
        with tarfile.open(archive) as source:
            for member in source.getmembers():
                if member.name.startswith('/') or '..' in Path(member.name).parts or member.issym() or member.islnk():
                    raise RuntimeError(f'Tar member không an toàn: {name}')
            source.extractall(root, filter='data')
        metadata = root / 'package/package.json'
        package = json.loads(metadata.read_text())
        if package['name'] != name or package['version'] != spec['version']:
            raise RuntimeError(f'Sai package nguồn: {name}')
        for dependency, version in package.get('peerDependencies', {}).items():
            if dependency.startswith('@earendil-works/pi-') and version != '*':
                package['peerDependencies'][dependency] = f'{version} || {pi_version}'
        metadata.write_text(json.dumps(package, indent=2) + '\n')
        output = root / 'repacked.tgz'
        with output.open('wb') as stream, gzip.GzipFile(fileobj=stream, mode='wb', mtime=0, filename='') as gz, tarfile.open(fileobj=gz, mode='w') as target:
            for child in sorted((root / 'package').rglob('*')):
                info = target.gettarinfo(str(child), str(child.relative_to(root)))
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                info.mtime = 0
                if child.is_file():
                    with child.open('rb') as source:
                        target.addfile(info, source)
                else:
                    target.addfile(info)
        if hashlib.sha256(output.read_bytes()).hexdigest() != spec['sha256']:
            raise RuntimeError(f'Tarball tái tạo khác checksum manifest: {name}')
        if args.write:
            shutil.copyfile(output, repo / 'vendor' / Path(spec['source']).name)
        print(f'PASS: {name}@{spec["version"]}: upstream integrity, metadata, tarball SHA256')
