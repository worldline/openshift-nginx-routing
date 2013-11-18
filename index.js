var fs = require('fs');
var Path = require('path');
var rimraf = require('rimraf');
var yaml = require('js-yaml');
var _ = require('underscore');
var async = require('async');
var stomp = require('stomp');
var mongodb = require('mongodb');
var uuid = require('uuid');

exports = module.exports = OORouter;

function OORouter(options){
  this.options = options;
  this.routes = {};
  try{
    this.nginxConfigTmpl = fs.readFileSync('/etc/openshift/openshift-nginx-routing.tmpl').toString();
  }catch(error){
    var localTemplateFile = Path.join(__dirname, 'openshift-nginx-routing.tmpl');
    console.error(error.message, 'Will load nginx template from ' + localTemplateFile);
    this.nginxConfigTmpl = fs.readFileSync(localTemplateFile).toString();
  }
}

// Read PID to reload nginx
var PID;
OORouter.prototype.reloadNginx = function(cb){
  var self = this;
  fs.readFile(self.options.nginxPidFile, function(error, pid){
    if(error){
      return cb(error);
    }
    if(!pid.toString()){
      return cb(new Error('PID file ' + self.options.nginxPidFile + ' is empty.'));
    }
    PID = pid.toString();
    doReloadNginx();
    cb();
  });
};

// send `kill -HUP pid` maximum every seconds, even if this function is called more.
var doReloadNginx = _.throttle(function(){
  process.kill(PID, 'SIGHUP');
}, 1000, {leading: false, trailing: true});

// Listen on activeMQ, and parse message body from yaml
OORouter.prototype.listenOnActiveMq = function(){
  console.log("listen on activeMq", this.options.activemq_login + '@' + this.options.activemq_host + ':' + this.options.activemq_port)
  this.stompClient = new stomp.Stomp({
    port: this.options.activemq_port,
    host: this.options.activemq_host,
    login: this.options.activemq_login,
    passcode: this.options.activemq_password,
  });

  this.stompClient.connect();
  var self = this;
  self.stompClient.once('connected', function() {
    console.log('Connected. Subscribe on', self.options.activemq_queue)
    self.stompClient.subscribe({
      destination: self.options.activemq_queue,
      ack: 'stompClient'
    }, function(){});
  });

  self.stompClient.on('error', function(error_frame) {
    console.error('stomp error', error_frame.body);
    self.disconnect();
  });

  self.stompClient.on('message', function(message) {
    self.stompClient.ack(message.headers['message-id']);
    console.log(message.headers['message-id'] ,message.body.toString());
    var body = yaml.safeLoad(message.body.toString());
    self.dispatch(message.headers['message-id'], body, function(error){
      if(error){
        return console.error(message.headers['message-id'], 'Error', error);
      }
      self.reloadNginx(function(error){
        if(error){
          return console.error(message.headers['message-id'], 'Error', error);
        }
        console.log(message.headers['message-id'], 'OK');
      });
    });
  });
}

OORouter.prototype.disconnect = function(){
  this.stompClient.disconnect();
}

// message coming from activemq_routing_plugin
OORouter.prototype.dispatch = function(id, message, cb){
  var routes = this.routes;
  var id = message[':app_name'] + '-' + message[':namespace'];
  var self = this;

  if(!this.options.regExp.test(id)){
    return cb();
  }
  switch(message[':action']){
    case ':create_application':
      routes[id] = {
        app_name: message[':app_name'],
        namespace: message[':namespace'],
        aliases: {}
      };

      // HTTPS template is based on alias.
      // Without an alias there is no nginx HTTPS configuration
      // Generate an alias for $APP_DNS
      var app_dns = message[':app_name'] + '-' + message[':namespace'] + '.' + self.options.domain;
      routes[id].aliases[app_dns] = {
        alias: app_dns
      };
      return cb();
    case ':delete_application':
      delete routes[id];
      return async.parallel([function(cb){
        self.removeConfig(id, cb);
      }, function(cb){
        self.removeCertificates(id, cb);
      }], cb)
    case ':add_alias':
      routes[id].aliases = routes[id].aliases || {} ;
      routes[id].aliases[message[':alias']] = {};
      routes[id].aliases[message[':alias']].alias = message[':alias'];
      return this.updateConfig(id, routes[id], cb);
    case ':remove_alias':
      delete routes[id].aliases[message[':alias']];
      return async.parallel([function(cb){
        self.updateConfig(id, routes[id], cb);
      }, function(cb){
        self.removeCertificate(id, message[':alias'], cb);
      }], cb)
    case ':add_ssl':
      if(message[':pass_phrase']){
        return console.log('WARN', id, 'pass_phrase is not supported with nginx');
      }
      routes[id].aliases[message[':alias']].ssl = message[':ssl'];
      routes[id].aliases[message[':alias']].private_key = message[':private_key'];
      routes[id].aliases[message[':alias']].pass_phrase = message[':pass_phrase'];
      return async.parallel([function(cb){
        self.updateConfig(id, routes[id], cb);
      }, function(cb){
        self.addCertificate(id, message[':alias'], routes[id], cb);
      }], cb)
    case ':remove_ssl': 
      delete routes[id].aliases[message[':alias']].ssl;
      delete routes[id].aliases[message[':alias']].private_key;
      delete routes[id].aliases[message[':alias']].pass_phrase;
      return async.parallel([function(cb){
        self.updateConfig(id, routes[id], cb);
      }, function(cb){
        self.removeCertificate(id, message[':alias'], cb);
      }], cb)
    case ':add_gear': 
      var socket = message[':public_address'] + ':' + message[':public_port'];
      if(!/http/.test(message[':protocols'])) return cb();
      if(!/web_framework/.test(message[':types'])) return cb();
      routes[id].gears = routes[id].gears || {};
      routes[id].gears[socket] = {
        public_port_name: message[':public_port_name'],
        public_address: message[':public_address'],
        public_port: message[':public_port'],
        protocols: message[':protocols'],
        types: message[':types'],
        mappings: message[':mappings']
      };
      return this.updateConfig(id, routes[id], cb);
    case ':delete_gear':
      var socket = message[':public_address'] + ':' + message[':public_port'];
      delete routes[id].gears[socket];
      return this.updateConfig(id, routes[id], cb);
    default:
      return cb(new Error("action '" + message[':action'] + "' not known"));
  }
}

// create or update nginx optionsuration file
// echo $DATA > ${NGINX_CONF_DIR}/${APP_NAME}-${NAMESPACE}.conf
OORouter.prototype.updateConfig = function(id, data, cb){
  // Group gears by mapping for nginx templating
  data.mapping = {};
  _(data.gears).forEach(function(gear, socket){
    gear.mappings.forEach(function(mapping){
      data.mapping[mapping.frontend] = data.mapping[mapping.frontend] || {};
      data.mapping[mapping.frontend].frontend = mapping.frontend;
      data.mapping[mapping.frontend].backend = mapping.backend;
      data.mapping[mapping.frontend].gears = data.mapping[mapping.frontend].gears || [];
      data.mapping[mapping.frontend].gears.push(gear);
    });
  });
  data.mapping = _(data.mapping).values();
  
  var nginxConfigFile = Path.join(this.options.nginxConfigDir, id + '.conf');
  var nginxConfig = _.template(this.nginxConfigTmpl, _.extend({options: this.options}, data));

  fs.writeFile(nginxConfigFile, nginxConfig, cb);
}

// remove nginx optionsuration file
// rm ${NGINX_CONF_DIR}/${APP_NAME}-${NAMESPACE}.conf
OORouter.prototype.removeConfig = function(id, cb){
  var nginxConfigFile = Path.join(this.options.nginxConfigDir, id + '.conf');
  fs.unlink(nginxConfigFile, cb)
}

// write certificate files for an alias
// mkdir ${NGINX_CONF_DIR}/${APP_NAME}-${NAMESPACE}
// echo $KEY > ${NGINX_CONF_DIR}/${APP_NAME}-${NAMESPACE}/${ALIAS}.key
// echo $CERT > ${NGINX_CONF_DIR}/${APP_NAME}-${NAMESPACE}/${ALIAS}.cert
OORouter.prototype.addCertificate = function(id, alias, route, cb){
  var certificatesDir = Path.join(this.options.nginxConfigDir, id);
  async.series([function(cb){
    fs.exists(certificatesDir, function(error, exists){
      if(error){
        return cb(error);
      }
      if(exists){
        return cb();
      }
      fs.mkdir(certificatesDir, cb);
    });
  }, function(cb){
    var keyFile = Path.join(certificatesDir, alias + '.key');
    fs.writeFile(keyFile, route.aliases[alias].private_key, cb);
  }, function(cb){
    var certFile = Path.join(certificatesDir, alias + '.crt');
    fs.writeFile(certFile, route.aliases[alias].ssl, cb);
  }], cb);
}

// delete certificate files for an alias
// rm ${NGINX_CONF_DIR}/${APP_NAME}-${NAMESPACE}/${ALIAS}.key
// rm ${NGINX_CONF_DIR}/${APP_NAME}-${NAMESPACE}/${ALIAS}.cert
OORouter.prototype.removeCertificate = function(id, alias, cb){
  var certificatesDir = Path.join(this.options.nginxConfigDir, id);
  async.parallel([function(cb){
    var keyFile = Path.join(certificatesDir, alias + '.key');
    fs.exists(keyFile, function(error, exists){
      if(error){
        return cb(error);
      }
      if(!exists){
        return cb();
      }
      fs.unlink(keyFile, cb);
    });
  }, function(cb){
    var certFile = Path.join(certificatesDir, alias + '.cert');
    fs.exists(certFile, function(error, exists){
      if(error){
        return cb(error);
      }
      if(!exists){
        return cb();
      }
      fs.unlink(certFile, cb);
    });
  }], cb);
}

// delete every certificates files for an application
// rm -fr ${NGINX_CONF_DIR}/${APP_NAME}-${NAMESPACE}
OORouter.prototype.removeCertificates = function(id, cb){
  var certificatesDir = Path.join(this.options.nginxConfigDir, id);
  rimraf(certificatesDir, cb);
}

// when regexp change, some nginx optionsurations and certificates has to be deleted.
// clean the memory as well
OORouter.prototype.onRegExpChange = function(cb){
  var routes = Object.keys(this.routes);
  var self = this;
  async.forEach(routes, function(id, cb){
    if(self.options.regExp.test(id)){
      return cb();
    }
    delete self.routes[id];

    async.parallel([function(cb){
      self.removeConfig(id, cb);
    }, function(cb){
      self.removeCertificates(id, cb);
    }], cb);
  }, function(error){
    if(error){
      return cb(error);
    }
    cb();
  });
}

// Retrive routes from MongoDB and transform data into routing messages for the dispatch function.
OORouter.prototype.retrieveRoutes = function(cb){
  console.log('Retrieve routes from MongoDB');
  var mongoClient = mongodb.MongoClient;
  var self = this;
  mongoClient.connect(this.options.mongodbUrl, function(error, db){
    if(error){
      return cb(error);
    }
    var collection = db.collection('applications');
    var stream = collection.find().stream();
    stream.once('error', function(error){
      cb(error)
    });
    stream.once('end', function(){
      db.close();
      self.reloadNginx(function(error){
        if(error){
          return cb(error);
        }
        cb();
      });
    });
    stream.on('data', function(app){
      if(!app.ha) return;
      if(!app.group_instances) return;
      app.group_instances.forEach(function(group){
        if(!group.gears) return;
        group.gears.forEach(function(gear){
          if(!gear.port_interfaces) return;
          gear.port_interfaces.forEach(function(portInterface){
            var id = 'init-' + uuid.v4();
            async.series([function(cb){
              // only send :create_application if application doesn't exists
              if(self.routes[app.name + '-' + app.domain_namespace]) return cb();
              var message = {};
              message[':action'] = ':create_application';
              message[':app_name'] = app.name;
              message[':namespace'] = app.domain_namespace;
              console.log(id, message);
              self.dispatch(id, message, cb);
            }, function(cb){
              var message = {};
              message[':action'] = ':add_gear';
              message[':app_name'] = app.name;
              message[':namespace'] = app.domain_namespace;
              message[':protocols'] = portInterface.protocols;
              message[':types'] = portInterface.type;
              message[':mappings'] = portInterface.mappings;
              message[':public_port'] = portInterface.external_port;
              message[':public_port_name'] = portInterface.cartridge_name;
              message[':public_address'] = gear.server_identity;
              console.log(id, message);
              self.dispatch(id, message, cb);
            }], function(error){
              if(error){
                return console.error(id, error);
              }
              console.log(id, 'OK');
            });
          });
        });
      });
    });
  });
}
