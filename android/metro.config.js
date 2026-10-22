// Lets the app import the shared, pure-TS code in ../src/shared (sync core,
// tags, images, link rewriting: one implementation for Mac + Android).
// Everything else resolves from android/node_modules as before.
const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
const shared = path.resolve(__dirname, '../src/shared')
config.watchFolders = [...(config.watchFolders ?? []), shared]
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')]
module.exports = config
