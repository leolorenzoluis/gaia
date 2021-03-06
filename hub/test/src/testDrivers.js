import test  from 'tape'

import proxyquire from 'proxyquire'
import FetchMock from 'fetch-mock'

import fs from 'fs'
import path from 'path'

import { Readable, Writable } from 'stream'

import * as auth from '../../lib/server/authentication'
import * as errors from '../../lib/server/errors'

import { testPairs, testAddrs} from './common'

const azConfigPath = process.env.AZ_CONFIG_PATH
const awsConfigPath = process.env.AWS_CONFIG_PATH
const diskConfigPath = process.env.DISK_CONFIG_PATH
const gcConfigPath = process.env.GC_CONFIG_PATH

export function addMockFetches(prefix, dataMap) {
  dataMap.forEach( item => {
    FetchMock.get(`${prefix}${item.key}`, item.data)
  })
}

function readStream(input, contentLength, callback) {
  var bufs = []
  input.on('data', function(d){ bufs.push(d) });
  input.on('end', function(){
    var buf = Buffer.concat(bufs)
    callback(buf.slice(0, contentLength))
  })
}

export function makeMockedAzureDriver() {
  const dataMap = []
  let bucketName = ''
  const createContainerIfNotExists = function(newBucketName, options, cb) {
    bucketName = newBucketName
    cb()
  }
  const createBlockBlobFromStream = function(putBucket, blobName, streamInput, contentLength, opts, cb) {
    if (bucketName !== putBucket) {
      cb(new Error(`Unexpected bucket name: ${putBucket}. Expected ${bucketName}`))
    }
    readStream(streamInput, contentLength, (buffer) => {
      dataMap.push({ data: buffer.toString(), key: blobName })
      cb()
    })
  }
  const listBlobsSegmentedWithPrefix = function(getBucket, prefix, continuation, data, cb) {
    const outBlobs = []
    dataMap.forEach(x => {
      if (x.key.startsWith(prefix)) {
        outBlobs.push({name: x.key})
      }
    })
    cb(null, {entries: outBlobs, continuationToken: null})
  }

  const createBlobService = function() {
    return { createContainerIfNotExists, createBlockBlobFromStream, listBlobsSegmentedWithPrefix }
  }

  const AzDriver = proxyquire('../../lib/server/drivers/AzDriver', {
    'azure-storage': { createBlobService }
  })
  return { AzDriver, dataMap }
}

function makeMockedS3Driver() {
  const dataMap = []
  let bucketName = ''

  const S3Class = class {
    headBucket(options, callback) {
      bucketName = options.Bucket
      callback()
    }
    upload(options, cb) {
      if (options.Bucket != bucketName) {
        cb(new Error(`Unexpected bucket name: ${options.Bucket}. Expected ${bucketName}`))
      }
      readStream(options.Body, 10000, (buffer) => {
        dataMap.push({ data: buffer.toString(), key: options.Key })
        cb()
      })
    }
    listObjectsV2(options, cb) {
      const contents = dataMap
      .filter((entry) => {
        return (entry.key.slice(0, options.Prefix.length) === options.Prefix)
      })
      .map((entry) => {
        return { Key: entry.key }
      })
      cb(null, { Contents: contents, isTruncated: false })
    }
  }

  const driver = proxyquire('../../lib/server/drivers/S3Driver', {
    'aws-sdk/clients/s3': S3Class
  })
  return { driver, dataMap }
}

class MockWriteStream extends Writable {
  constructor(dataMap, filename) {
    super({})
    this.dataMap = dataMap
    this.filename = filename
    this.data = ''
  }
  _write(chunk, encoding, callback) {
    this.data += chunk
    callback()
  }
  _final(callback) {
    this.dataMap.push({ data: this.data, key: this.filename })
    callback()
  }
}

function makeMockedGcDriver() {
  const dataMap = []
  let myName = ''

  const file = function (filename) {
    const createWriteStream = function() {
      return new MockWriteStream(dataMap, filename)
    }
    return { createWriteStream }
  }
  const exists = function () {
    return Promise.resolve([true])
  }
  const StorageClass = class {
    bucket(bucketName) {
      if (myName === '') {
        myName = bucketName
      } else {
        if (myName !== bucketName) {
          throw new Error(`Unexpected bucket name: ${bucketName}. Expected ${myName}`)
        }
      }
      return { file, exists, getFiles: this.getFiles }
    }

    getFiles(options, cb) {
      const files = dataMap.map((entry) => {
        return { name: entry.key }
      })
      cb(null, files, null)
    }
  }

  const driver = proxyquire('../../lib/server/drivers/GcDriver', {
    '@google-cloud/storage': StorageClass
  })
  return { driver, dataMap }
}

function testAzDriver() {
  let config = {
    "azCredentials": {
      "accountName": "mock-azure",
      "accountKey": "mock-azure-key"
    },
    "bucket": "spokes"
  }
  let mockTest = true

  if (azConfigPath) {
    config = JSON.parse(fs.readFileSync(azConfigPath))
    mockTest = false
  }

  let AzDriver, dataMap
  const azDriverImport = '../../lib/server/drivers/AzDriver'
  if (mockTest) {
    const mockedObj = makeMockedAzureDriver()
    dataMap = mockedObj.dataMap
    AzDriver = mockedObj.AzDriver
  } else {
    AzDriver = require(azDriverImport)
  }

  test('azDriver', (t) => {
    const driver = new AzDriver(config)
    const prefix = driver.getReadURLPrefix()
    const s = new Readable()
    s._read = function noop() {}
    s.push('hello world')
    s.push(null)

    driver.performWrite(
      { path: '../foo.js'})
      .then(() => t.ok(false, 'Should have thrown'))
      .catch((err) => t.equal(err.message, 'Invalid Path', 'Should throw bad path'))
      .then(() => driver.performWrite(
        { path: 'foo.txt',
          storageTopLevel: '12345',
          stream: s,
          contentType: 'application/octet-stream',
          contentLength: 12 }))
      .then((readUrl) => {
        if (mockTest) {
          addMockFetches(prefix, dataMap)
        }

        t.ok(readUrl.startsWith(prefix), `${readUrl} must start with readUrlPrefix ${prefix}`)
        return fetch(readUrl)
      })
      .then((resp) => resp.text())
      .then((resptxt) => t.equal(resptxt, 'hello world', `Must get back hello world: got back: ${resptxt}`))
      .then(() => driver.listFiles('12345'))
      .then((files) => {
        t.equal(files.entries.length, 1, 'Should return one file')
        t.equal(files.entries[0], 'foo.txt', 'Should be foo.txt!')
      })
      .catch((err) => t.false(true, `Unexpected err: ${err}`))
      .then(() => { FetchMock.restore(); t.end() })
  })
}

function testS3Driver() {
  let config = {
    "bucket": "spokes"
  }
  let mockTest = true

  if (awsConfigPath) {
    config = JSON.parse(fs.readFileSync(awsConfigPath))
    mockTest = false
  }

  let S3Driver, dataMap
  const S3DriverImport = '../../lib/server/drivers/S3Driver'
  if (mockTest) {
    const mockedObj = makeMockedS3Driver()
    dataMap = mockedObj.dataMap
    S3Driver = mockedObj.driver
  } else {
    S3Driver = require(S3DriverImport)
  }

  test('awsDriver', (t) => {
    const driver = new S3Driver(config)
    const prefix = driver.getReadURLPrefix()
    const s = new Readable()
    s._read = function noop() {}
    s.push('hello world')
    s.push(null)

    driver.performWrite(
      { path: '../foo.js'})
      .then(() => t.ok(false, 'Should have thrown'))
      .catch((err) => t.equal(err.message, 'Invalid Path', 'Should throw bad path'))
      .then(() => driver.performWrite(
        { path: 'foo.txt',
          storageTopLevel: '12345',
          stream: s,
          contentType: 'application/octet-stream',
          contentLength: 12 }))
      .then((readUrl) => {
        if (mockTest) {
          addMockFetches(prefix, dataMap)
        }
        else {
        }
        t.ok(readUrl.startsWith(prefix + '12345'), `${readUrl} must start with readUrlPrefix ${prefix}12345`)
        return fetch(readUrl)
      })
      .then((resp) => resp.text())
      .then((resptxt) => t.equal(resptxt, 'hello world', `Must get back hello world: got back: ${resptxt}`))
      .then(() => driver.listFiles('12345'))
      .then((files) => {
        t.equal(files.entries.length, 1, 'Should return one file')
        t.equal(files.entries[0], 'foo.txt', 'Should be foo.txt!')
      })
      .catch((err) => t.false(true, `Unexpected err: ${err}`))
      .then(() => { FetchMock.restore(); })
      .catch(() => t.false(true, `Unexpected err: ${err}`))
      .then(() => { FetchMock.restore(); t.end() })
  })
}

/*
 * To run this test, you should run an HTTP server on localhost:4000
 * and use the ../config.sample.disk.json config file.
 */
function testDiskDriver() {
  if (!diskConfigPath) {
    return
  }
  const config = JSON.parse(fs.readFileSync(diskConfigPath))
  const diskDriverImport = '../../lib/server/drivers/diskDriver'
  const DiskDriver = require(diskDriverImport)

  test('diskDriver', (t) => {
    t.plan(5)
    const driver = new DiskDriver(config)
    const prefix = driver.getReadURLPrefix()
    const storageDir = driver.storageRootDirectory
    const s = new Readable()
    s._read = function noop() {}
    s.push('hello world')
    s.push(null)

    driver.performWrite(
      { path: '../foo.js'})
      .then(() => t.ok(false, 'Should have thrown'))
      .catch((err) => t.equal(err.message, 'Invalid Path', 'Should throw bad path'))
      .then(() => driver.performWrite(
        { path: 'foo/bar.txt',
          storageTopLevel: '12345',
          stream: s,
          contentType: 'application/octet-stream',
          contentLength: 12 }))
      .then((readUrl) => {
        const filePath = path.join(storageDir, '12345', 'foo/bar.txt')
        const metadataPath = path.join(storageDir, '.gaia-metadata', '12345', 'foo/bar.txt')
        t.ok(readUrl.startsWith(prefix + '12345'), `${readUrl} must start with readUrlPrefix ${prefix}12345`)
        t.equal(JSON.parse(fs.readFileSync(metadataPath).toString())['content-type'], 'application/octet-stream',
          'Content-type metadata was written')
      })
      .then(() => driver.listFiles('12345'))
      .then((files) => {
        t.equal(files.entries.length, 1, 'Should return one file')
        t.equal(files.entries[0], 'foo/bar.txt', 'Should be foo.txt!')
      })
  })
}

function testGcDriver() {
  let config = {
    "bucket": "spokes"
  }
  let mockTest = true

  if (gcConfigPath) {
    config = JSON.parse(fs.readFileSync(gcConfigPath))
    mockTest = false
  }

  let GcDriver, dataMap
  const GcDriverImport = '../../lib/server/drivers/GcDriver'
  if (mockTest) {
    const mockedObj = makeMockedGcDriver()
    dataMap = mockedObj.dataMap
    GcDriver = mockedObj.driver
  } else {
    GcDriver = require(GcDriverImport)
  }

  test('Google Cloud Driver', (t) => {
    const driver = new GcDriver(config)
    const prefix = driver.getReadURLPrefix()
    const s = new Readable()
    s._read = function noop() {}
    s.push('hello world')
    s.push(null)

    driver.performWrite(
      { path: '../foo.js'})
      .then(() => t.ok(false, 'Should have thrown'))
      .catch((err) => t.equal(err.message, 'Invalid Path', 'Should throw bad path'))
      .then(() => driver.performWrite(
        { path: 'foo.txt',
          storageTopLevel: '12345',
          stream: s,
          contentType: 'application/octet-stream',
          contentLength: 12 }))
      .then((readUrl) => {
        if (mockTest) {
          addMockFetches(prefix, dataMap)
        }
        t.ok(readUrl.startsWith(prefix + '12345'), `${readUrl} must start with readUrlPrefix ${prefix}12345`)
        return fetch(readUrl)
      })
      .then((resp) => resp.text())
      .then((resptxt) => t.equal(resptxt, 'hello world', `Must get back hello world: got back: ${resptxt}`))
      .then(() => driver.listFiles('12345'))
      .then((files) => {
        t.equal(files.entries.length, 1, 'Should return one file')
        t.equal(files.entries[0], 'foo.txt', 'Should be foo.txt!')
      })
      .catch((err) => t.false(true, `Unexpected err: ${err}`))
      .then(() => { FetchMock.restore(); t.end() })
  })
}

export function testDrivers() {
  testAzDriver()
  testS3Driver()
  testDiskDriver()
  testGcDriver()
}
