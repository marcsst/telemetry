const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const fs = require('fs')

const { DiagLogLevel } = require('@opentelemetry/api')
const { Resource } = require('@opentelemetry/resources')
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions')

function getDiagLogLevel() {
  if (LOG._trace) return DiagLogLevel.VERBOSE
  if (LOG._debug) return DiagLogLevel.DEBUG
  if (LOG._info) return DiagLogLevel.INFO
  if (LOG._warn) return DiagLogLevel.WARN
  if (LOG._error) return DiagLogLevel.ERROR
  return DiagLogLevel.NONE
}

function getResource() {
  const VCAP_APPLICATION = process.env.VCAP_APPLICATION && JSON.parse(process.env.VCAP_APPLICATION)

  let PKG
  try {
    PKG = require(cds.root + '/package.json')
  } catch (err) {
    LOG._info && LOG.info('Unable to require package.json to resolve app name and version due to error:', err)
  }

  const name = PKG?.name || VCAP_APPLICATION?.name || 'CAP Application'
  const version = PKG?.version || VCAP_APPLICATION?.application_version || '1.0.0'

  const attributes = {}

  // Service
  attributes[SemanticResourceAttributes.SERVICE_NAME] = process.env.OTEL_SERVICE_NAME || name
  attributes[SemanticResourceAttributes.SERVICE_VERSION] = process.env.OTEL_SERVICE_VERSION || version

  // Service (Experimental)
  if (process.env.OTEL_SERVICE_NAMESPACE)
    attributes[SemanticResourceAttributes.SERVICE_NAMESPACE] = process.env.OTEL_SERVICE_NAMESPACE
  if (VCAP_APPLICATION) attributes[SemanticResourceAttributes.SERVICE_INSTANCE_ID] = VCAP_APPLICATION.instance_id

  if (process.env.CF_INSTANCE_GUID) {
    attributes[SemanticResourceAttributes.SERVICE_INSTANCE_ID] = process.env.CF_INSTANCE_GUID
    attributes['sap.cf.instance_id'] = process.env.CF_INSTANCE_GUID
  }

  if (VCAP_APPLICATION) {
    attributes['sap.cf.source_id'] = VCAP_APPLICATION.application_id
    attributes['sap.cf.app_id'] = VCAP_APPLICATION.application_id
    attributes['sap.cf.app_name'] = name
    attributes['sap.cf.space_id'] = VCAP_APPLICATION.space_id
    attributes['sap.cf.space_name'] = VCAP_APPLICATION.space_name
    attributes['sap.cf.org_id'] = VCAP_APPLICATION.organization_id
    attributes['sap.cf.org_name'] = VCAP_APPLICATION.organization_name
    attributes['sap.cf.source_type'] = 'APP/PROC/WEB'
    attributes['sap.cf.process.id'] = VCAP_APPLICATION.process_id
    attributes['sap.cf.process.instance_id'] = VCAP_APPLICATION.instance_id
    attributes['sap.cf.process.type'] = VCAP_APPLICATION.process_type
  }

  return new Resource(attributes)
}

let dtmetadata
function getDynatraceMetadata() {
  if (dtmetadata) return dtmetadata

  dtmetadata = new Resource({})
  for (let name of [
    'dt_metadata_e617c525669e072eebe3d0f08212e8f2.json',
    '/var/lib/dynatrace/enrichment/dt_metadata.json'
  ]) {
    try {
      LOG._debug && LOG.debug(`Trying to read dtmetadata source "${name}" ...`)
      const content = fs
        .readFileSync(name.startsWith('/var') ? name : fs.readFileSync(name).toString('utf-8').trim())
        .toString('utf-8')
      LOG._debug && LOG.debug('Successful')
      dtmetadata = dtmetadata.merge(new Resource(JSON.parse(content)))
      break
    } catch (err) {
      LOG._debug && LOG.debug('Failed with error:', err)
    }
  }
  return dtmetadata
}

function getDynatraceCredentials() {
  if (!process.env.VCAP_SERVICES) return
  const vcap = JSON.parse(process.env.VCAP_SERVICES)
  if (vcap.dynatrace?.[0]?.credentials) return vcap.dynatrace?.[0]?.credentials
  // to support connection via user-provided services, APMs requirement is that the instance name contains "dynatrace"
  if (vcap['user-provided']?.some(b => b.name.match(/dynatrace/)))
    return vcap['user-provided'].find(b => b.name.match(/dynatrace/)).credentials
}

function getCloudLoggingCredentials() {
  const cloud_logging =
    process.env.VCAP_SERVICES && JSON.parse(process.env.VCAP_SERVICES)['cloud-logging']?.[0]?.credentials
  if (cloud_logging) {
    if (!cloud_logging['ingest-otlp-endpoint']) {
      throw new Error(
        'No OpenTelemetry credentials found in SAP Cloud Logging binding. Create instance with config: "{ ingest_otlp: { enabled: true } }".'
      )
    }
    const grpc = _require('@grpc/grpc-js')
    const secureContext = require('tls').createSecureContext({
      cert: cloud_logging['ingest-otlp-cert'],
      key: cloud_logging['ingest-otlp-key']
    })
    return {
      url: 'https://' + cloud_logging['ingest-otlp-endpoint'],
      credentials: grpc.credentials.createFromSecureContext(secureContext)
    }
  }
}

let PKG
function hasDependency(name) {
  if (!PKG) {
    try {
      PKG = require(cds.root + '/package.json')
    } catch (err) {
      LOG._info && LOG.info(`Unable to require package.json to check for dependency "${name}" due to error:`, err)
      return false
    }
  }
  return !!PKG.dependencies[name]
}

function _require(name) {
  name = Array.isArray(name) ? name[0] : name
  try {
    return require(name)
  } catch (e) {
    e.message = `Cannot find module '${name}'. Make sure to install it with 'npm i ${name}'\n` + e.message
    throw e
  }
}

module.exports = {
  getDiagLogLevel,
  getResource,
  getDynatraceMetadata,
  getDynatraceCredentials,
  getCloudLoggingCredentials,
  hasDependency,
  _require
}
