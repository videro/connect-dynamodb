/*!
 * Connect - DynamoDB
 * Copyright(c) 2018 humbly LLC <support@humbly.com>
 * MIT Licensed
 */
/**
 * Module dependencies.
 */
var AWS = require('aws-sdk');

/**
 * One day in milliseconds.
 */

var oneDayInMilliseconds = 86400000;

/**
 * Return the `DynamoDBStore` extending `connect`'s session Store.
 *
 * @param {object} connect
 * @return {Function}
 * @api public
 */

module.exports = function (connect) {
    /**
     * Connect's Store.
     */

    var Store = connect.session.Store;

    /**
     * Initialize DynamoDBStore with the given `options`.
     *
     * @param {Object} options
     * @api public
     */

    function DynamoDBStore(options) {
        options = options || {};
        Store.call(this, options);
        this.prefix = null == options.prefix ? 'sess:' : options.prefix;
        this.hashKey = null == options.hashKey ? 'id' : options.hashKey;
        this.readCapacityUnits = null == options.readCapacityUnits ? 5 : parseInt(options.readCapacityUnits,10);
        this.writeCapacityUnits = null == options.writeCapacityUnits ? 5 : parseInt(options.writeCapacityUnits,10);


        if (options.client) {
            this.client = options.client;
        } else {
      	    if (options.AWSConfigPath) {
      	        AWS.config.loadFromPath(options.AWSConfigPath);
            } else if (options.AWSConfigJSON) {
                AWS.config.update(options.AWSConfigJSON);
      	    } else if(options.AWSRegion){
      	        AWS.config.update({region: options.AWSRegion});
      	    }
            this.client = new AWS.DynamoDB();
        }

        this.table = options.table || 'sessions';
        this.reapInterval = options.reapInterval || 0;
        if (this.reapInterval > 0) {
            this._reap = setInterval(this.reap.bind(this), this.reapInterval);
        }

        this.touchAfter = null == options.touchAfter ? 0 : options.touchAfter;
        this.documentClient = new AWS.DynamoDB.DocumentClient({
            service: this.client,
        });

        // check if sessions table exists, otherwise create it
        this.client.describeTable({
            TableName: this.table
        }, function (error, info) {
            if (error) {
                this.client.createTable({
                    TableName: this.table,
                    AttributeDefinitions: [{
                        AttributeName: this.hashKey,
                        AttributeType: 'S'
                    }],
                    KeySchema: [{
                        AttributeName: this.hashKey,
                        KeyType: 'HASH'
                    }],
                    ProvisionedThroughput: {
                        ReadCapacityUnits: this.readCapacityUnits,
                        WriteCapacityUnits: this.writeCapacityUnits
                    }
                }, console.log);
            }
        }.bind(this));
    };

    /*
     *  Inherit from `Store`.
     */

    DynamoDBStore.prototype.__proto__ = Store.prototype;

    /**
     * Attempt to fetch session by the given `sid`.
     *
     * @param {String} sid
     * @param {Function} fn
     * @api public
     */

    DynamoDBStore.prototype.get = function (sid, fn) {
        sid = this.prefix + sid;
        var now = Math.floor(Date.now() / 1000);
        
        //this.client.getItem({
        this.documentClient.get({
            TableName: this.table,
            Key: {
                [this.hashKey]: sid
            },
            ConsistentRead: true
        }, function (err, result) {
            if (err) {
                fn(err);
            } else {
                try {
                    if (!result.Item) return fn(null, null);
                    else if (result.Item.expires && now >= result.Item.expires) {
                        fn(null, null);
                    } else {
                        fn(null, JSON.parse(result.Item.sess));
                    }
                } catch (err) {
                    fn(err);
                }
            }
        }.bind(this));
    };

    /**
     * Commit the given `sess` object associated with the given `sid`.
     *
     * @param {String} sid
     * @param {Session} sess
     * @param {Function} fn
     * @api public
     */

    DynamoDBStore.prototype.set = function (sid, sess, fn) {
        sid = this.prefix + sid;
        var expires = this.getExpiresValue(sess);

        sess.updated = Date.now();
        const params = {
            TableName: this.table,
            Item: {
                [this.hashKey]: sid,
                expires: expires,
                type: 'connect-session',
                sess: JSON.stringify(sess)
            }
        };
        this.documentClient.put(params, fn);
    };

    /**
     * Cleans up expired sessions
     *
     * @param {Function} fn
     * @api public
     */

    DynamoDBStore.prototype.reap = function (fn) {
        var now = Math.floor(Date.now() / 1000);
        var options = {
            endkey: '[' + now + ',{}]'
        };
        var params = {
            TableName: this.table,
            ScanFilter: {
                "expires": {
                    "AttributeValueList": [{
                        "N": now.toString()
                    }],
                    "ComparisonOperator": "LT"
                }
            },
            AttributesToGet: ["id"]
        };
        this.client.scan(params, function onScan(err, data) {
            if (err) return fn && fn(err);
            destroy.call(this, data, fn);
            if (typeof data.LastEvaluatedKey != "undefined") {
                params.ExclusiveStartKey = data.LastEvaluatedKey;
                this.client.scan(params, onScan.bind(this));
            }
        }.bind(this));
    };

    function destroy(data, fn) {
        var self = this;

        function destroyDataAt(index) {
            if (data.Count > 0 && index < data.Count) {
                var sid = data.Items[index].id.S;
                sid = sid.substring(self.prefix.length, sid.length);
                self.destroy(sid, function () {
                    destroyDataAt(index + 1);
                });
            } else {
                return fn && fn();
            }
        }
        destroyDataAt(0);
    }

    /**
     * Destroy the session associated with the given `sid`.
     *
     * @param {String} sid
     * @param {Function} fn
     * @api public
     */
    DynamoDBStore.prototype.destroy = function (sid, fn) {
        sid = this.prefix + sid;
        this.documentClient.delete({
            TableName: this.table,
            Key: {
                id: sid
            }
        }, fn || function () {});
    };


    /**
     * Calculates the expire value based on the configuration.
     * @param  {Object} sess Session object.
     * @return {Integer}      The expire on timestamp.
     */
    DynamoDBStore.prototype.getExpiresValue = function (sess) {
      var expires = typeof sess.cookie.maxAge === 'number' ? (+new Date()) + sess.cookie.maxAge : (+new Date()) + oneDayInMilliseconds;
      return Math.floor(expires / 1000);
    }

    /**
     * Touches the session row to update it's expire value.
     * @param  {String}   sid  Session id.
     * @param  {Object}   sess Session object.
     * @param  {Function} fn   Callback.
     */
    DynamoDBStore.prototype.touch  = function (sid, sess, fn) {
        var now = Date.now();
        if (!sess.updated || Number(sess.updated) + this.touchAfter <= now) {
            sid = this.prefix + sid;
            var expires = this.getExpiresValue(sess);

            sess.updated = now;
            var params = {
                TableName: this.table,
                Key: {
                    [this.hashKey]: sid
                },
                UpdateExpression: 'set expires = :e, sess = :s',
                ExpressionAttributeValues:{
                    ':e': expires,
                    ':s': JSON.stringify(sess)
                },
                ReturnValues: 'UPDATED_NEW'
            };
           
            //console.log('TOUCHING session', expires);
            this.documentClient.update(params, fn || function () {});
        }else{
            //console.log('skipping touch of session');
            fn(null);
        }
    };

    /**
     * Clear intervals
     *
     * @api public
     */

    DynamoDBStore.prototype.clearInterval = function () {
        if (this._reap) clearInterval(this._reap);
    };

    return DynamoDBStore;
};
