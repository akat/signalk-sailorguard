'use strict'

const fs = require('fs')
const path = require('path')

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Keep the unreadable file for inspection instead of silently overwriting it.
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
      } catch (_) {}
    }
    return fallback
  }
}

// Write-then-rename so a power cut on the boat never leaves a half-written file.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

module.exports = { readJson, writeJson }
