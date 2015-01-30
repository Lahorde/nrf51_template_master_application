/*jshint loopfunc: true */

var debug = require('debug')('nrf51_node');
var events = require('events');
var util = require('util');

var noble = require('noble');

/*********************************
 * bluetooth services
 *********************************/
//Generic access service
var GENERIC_ACCESS_UUID = '1800';
//service characteristics uuids
var DEVICE_NAME_UUID = '2a00';
var APPEARANCE_UUID = '2a01';
var PERIPHERAL_PREFERRED_CONNECTION_PARAMETERS_UUID = '2a04';

//Generic attribute service
var GENERIC_ATTRIBUTE_UUID = '1801';

//nRF51Node UART service
var template_app_SERVICE_UUID = '6e400001b5a3f393e0a9e50e24dcca9e';
//enable notification to this service to receive data
var RX_UUID = '6e400003b5a3f393e0a9e50e24dcca9e';
//write data on this service to send data to NRF51Node
var TX_UUID = '6e400002b5a3f393e0a9e50e24dcca9e';

function NRF51Node(peripheral) {
	this._peripheral = peripheral;
	this._services = {};
	this._characteristics = {};
	this._bindings = {};

	//Attributes for restoration after a connection drop
	this._enabledNotifications = [];
	this._writtenCharacteristics = {};

	this._uuid = peripheral.uuid;

	this._peripheral.on('connectionDrop', this.onConnectionDrop.bind(this));
	this._peripheral.on('disconnect', this.onDisconnect.bind(this));
	this._peripheral.on('connect', this.onConnect.bind(this));

	//Set all bindings - workaround to Nodejs events listener implementation : two same methods binded won't be
	//recognized as same listener
	this._bindings.onDataReceived = this.onDataReceived.bind(this);
}

util.inherits(NRF51Node, events.EventEmitter);

NRF51Node.discover = function (callback, uuid) {
    debug("start discover");
	var startScanningOnPowerOn = function () {
		if (noble.state === 'poweredOn') {
			var onDiscover = function (peripheral) {
			    debug("some peripheral discovered - local name = " + peripheral.advertisement.localName + ', uuid = ' + peripheral.uuid);
				if (peripheral.advertisement.localName === 'template_app' && (uuid === undefined || uuid === peripheral.uuid)) {
					noble.removeListener('discover', onDiscover);
					noble.stopScanning();
					callback(new NRF51Node(peripheral));
				}
				else{
					debug("peripheral is not a nrf51");
				}
			};

			noble.on('discover', onDiscover);

			noble.startScanning();
		} else {
			noble.once('stateChange', startScanningOnPowerOn);
		}
	};

	startScanningOnPowerOn();
};

NRF51Node.prototype.onConnectionDrop = function () {
	//Reconnect in all cases 
	debug('connection dropped - reconnect');
	this._peripheral.reconnect();
	this.emit('connectionDrop');
};

NRF51Node.prototype.onReconnectAfterCharsDiscovery = function () {
	this.restoreCharsAndNotifs(function () {});
	this.emit('reconnect');
};

NRF51Node.prototype.onReconnectDuringCharsDiscovery = function (callback) {
	this.discoverServicesAndCharacteristics(callback);
	this.emit('reconnect');
};

NRF51Node.prototype.restoreCharsAndNotifs = function () {
	debug('restore ble_mini written characteristics and notifications after connection drop');
	var char_uuid, char_index;

	//Try to restore written characteristics - listener have already been registered
	for (char_uuid in this._writtenCharacteristics) {
		if(this._characteristics.hasOwnProperty(char_uuid) && this._writtenCharacteristics.hasOwnProperty(char_uuid)){
			this._characteristics[char_uuid].write(this._writtenCharacteristics[char_uuid], false, function () {});
		}
	}

	//Try to restore enabled notifications
	for (char_index = 0; char_index < this._enabledNotifications.length; char_index++) {
		this._enabledNotifications[char_index].notify(true, function (state) {});
	}
	this.emit('reconnect');
};


NRF51Node.prototype.onDisconnect = function () {
	this.emit('disconnect');
};

NRF51Node.prototype.onConnect = function () {
	this.emit('connect');
};

NRF51Node.prototype.toString = function () {
	return JSON.stringify({
		uuid: this.uuid
	});
};

NRF51Node.prototype.connect = function (callback) {
	this._peripheral.connect(callback);
};

NRF51Node.prototype.disconnect = function (callback) {
	//Empty data stored for reconnection
	this._enabledNotifications.length = 0;
	this._writtenCharacteristics = {};

	this._peripheral.disconnect(callback);
};

NRF51Node.prototype.discoverServicesAndCharacteristics = function (callback) {
	this._peripheral.removeAllListeners('reconnect');
	this._peripheral.on('reconnect', this.onReconnectDuringCharsDiscovery.bind(this, callback));
	this._peripheral.discoverAllServicesAndCharacteristics(function (error, services, characteristics) {
		if (error === null) {
			for (var i in services) {
				if(services.hasOwnProperty(i)){
					var service = services[i];
					debug('service ' + service + 'discovered');
					this._services[service.uuid] = service;
				}
			}

			for (var j in characteristics) {
				if(characteristics.hasOwnProperty(j)){
					var characteristic = characteristics[j];
					debug('characteristic ' + characteristic + 'discovered');
					this._characteristics[characteristic.uuid] = characteristic;
				}
			}
		}

		this._peripheral.removeAllListeners('reconnect');
		this._peripheral.on('reconnect', this.onReconnectAfterCharsDiscovery.bind(this));
		callback();
	}.bind(this));
};

NRF51Node.prototype.writeCharacteristic = function (uuid, data, callback) {
	this._characteristics[uuid].write(data, false, function () {
		//Keep written characteristics for a possible restoration
		this._writtenCharacteristics[uuid] = data;
		callback();
	}.bind(this));
};

NRF51Node.prototype.notifyCharacteristic = function (uuid, notify, listener, callback) {
	var characteristic = this._characteristics[uuid];
	if (characteristic === undefined) {
		//TODO throw error
		debug('characteristic with uuid ' + uuid + ' not supported by sensortag');
		callback();
	} else {
		characteristic.notify(notify, function (state) {
			if (notify) {
				characteristic.on('read', listener);
				//Keep notification state for a possible restoration
				this._enabledNotifications.push(characteristic);
			} else {
				characteristic.removeListener('read', listener);
				//Remove from notification array if notification have been disabled
				var charIndex = this._enabledNotifications.indexOf(characteristic);
				if (charIndex !== -1) {
					this._enabledNotifications.splice(charIndex, 1);
				}
			}
			callback();
		}.bind(this));
	}
};

NRF51Node.prototype.readDataCharacteristic = function (uuid, callback) {
	if (this._characteristics[uuid] === undefined) {
		debug('characteristic with uuid ' + uuid + ' not supported by ble_mini_node');
	}
	else{
		this._characteristics[uuid].read(function (error, data) {
			callback(data);
		});
	}
};

NRF51Node.prototype.readStringCharacteristic = function (uuid, callback) {
	this.readDataCharacteristic(uuid, function (data) {
		callback(data.toString());
	});
};

NRF51Node.prototype.readDeviceName = function (callback) {
	this.readStringCharacteristic(DEVICE_NAME_UUID, callback);
};

NRF51Node.prototype.readAppearance = function (callback) {
	this.readDataCharacteristic(APPEARANCE_UUID, callback);
};

NRF51Node.prototype.readPreferredConnParams = function (callback) {
	this.readDataCharacteristic(PERIPHERAL_PREFERRED_CONNECTION_PARAMETERS_UUID, callback);
};

NRF51Node.prototype.writeData = function (data, callback) {
	this.writeCharacteristic(TX_UUID, data, callback);
};

NRF51Node.prototype.notifyDataReceive = function (callback) {
	this.notifyCharacteristic(RX_UUID, true, this._bindings.onDataReceived, callback);
};

NRF51Node.prototype.unnotifyDataReceive = function (callback) {
	this.notifyCharacteristic(RX_UUID, false, this._bindings.onDataReceived, callback);
};

NRF51Node.prototype.onDataReceived = function (data) {
	this.emit('dataReceived', data);
};

module.exports = NRF51Node;