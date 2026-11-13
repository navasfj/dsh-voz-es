#!/usr/bin/env node
/**
 * Genera index.json (formato 1) para la pestaña Discover de DeepSeek Harness.
 *
 * Uso:
 *   node scripts/make-index.mjs [usuario/repositorio]
 *
 * Sin argumento toma la URL del remoto `origin`. El índice fija el commit
 * actual y las versiones de los dos paquetes, así que hay que regenerarlo y
 * volver a commitearlo después de cada cambio que se quiera publicar.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** @returns {string} `usuario/repositorio` del argumento o del remoto origin. */
function repositoryOf() {
  if (process.argv[2] !== undefined) return process.argv[2].replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim()
  return remote.replace(/^https:\/\/github\.com\//, '').replace(/^git@github\.com:/, '').replace(/\.git$/, '')
}

const repository = repositoryOf()
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  console.error(`No se pudo leer el repositorio: ${repository}`)
  process.exit(1)
}
const url = `https://github.com/${repository}`
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const publishedAt = Number(execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim())
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error('El commit de HEAD no es un SHA de 40 caracteres')
  process.exit(1)
}

const packages = [
  {
    directory: 'packages/dsh-whisper-voice',
    title: 'Dictado con Whisper en español',
    description: 'Reconocimiento local con Whisper para el micrófono de DSH, con español y modelos verificados.',
  },
  {
    directory: 'packages/dsh-read-aloud',
    title: 'Leer respuestas en voz alta',
    description: 'Lee las respuestas con la voz local Piper, con botón de altavoz, silencio y pausa/reanudación.',
  },
].map((entry) => {
  const manifest = JSON.parse(readFileSync(join(root, entry.directory, 'package.json'), 'utf8'))
  return {
    name: manifest.name,
    title: entry.title,
    description: entry.description,
    author: repository.split('/')[0],
    repository: { url, directory: entry.directory },
    versions: [{
      version: manifest.version,
      publishTimestamp: publishedAt,
      source: { type: 'git', url, commit, path: entry.directory },
      engines: { dsh: '>=0.2.2-rc.2 <0.3.0' },
    }],
  }
})

const index = {
  format: 1,
  title: 'Voz en español para DSH',
  description: 'Dictado con Whisper y lectura en voz alta con Piper, todo local.',
  plugins: packages,
}

writeFileSync(join(root, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`index.json escrito para ${repository} @ ${commit.slice(0, 10)}`)
