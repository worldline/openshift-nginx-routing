# openshift-nginx-routing

OpenShift Nginx Routing listen on the Routing SPI and update nginx configurations to point directly to the web endpoints.

Nginx is reloaded without downtime when:
* it starts and retrieves endpoints from mongodb
* creating/deleting an application
* scaling up/down an application
* adding/removing alias
* adding/removing custom certificates
* adding/removing endpoints

Node Apache, Node Proxy and Gear HA-Proxy are bypassed.

## Install

    $ git clone https://github.com/Filirom1/openshift-nginx-routing.git
    $ cd openshift-nginx-routing
    $ npm install
    # or 
    $ scl enable nodejs010 "npm install"

Edit configuration file in `conf/openshift-nginx-routing.conf`

## Install nginx

http://wiki.nginx.org/Install

If you want to run openshift-nginx-routing an an OpenShift Node, change nginx listenging ports in `openshift-nginx-routing.tmpl`

Generate ssl keys and certificates

    $ cd /etc/ssl/certs/
    $ openssl genrsa -des3 -out server.key.pass 1024
    $ openssl rsa -in server.key.pass -out server.key
    $ openssl req -new -key server.key -out server.csr
    $ openssl x509 -req -days 365 -in server.csr -signkey server.key -out server.crt

Authorize openshift-nginx-routing to write nginx configuration files.

    $ chown -R nginx. /etc/nginx/conf.d/

Change default nginx configuration. It will served the default index.html when applications are not found:

    $ vim /etc/nginx/conf.d/default.conf
    server {
        listen       80 default_server;
        listen     8000 default_server;
        server_name  _;
    
        #charset koi8-r;
        #access_log  /var/log/nginx/log/host.access.log  main;
    
        location / {
            root   /usr/share/nginx/html;
            index  index.html index.htm;
        }
    
        #error_page  404              /404.html;
    
        # redirect server error pages to the static page /50x.html
        #
        error_page   500 502 503 504  /50x.html;
        location = /50x.html {
            root   /usr/share/nginx/html;
        }
    
    }
    
    server {
      listen               443 default_server ssl;
      listen               8443 default_server ssl;
      server_name  _;
    
      proxy_set_header     X-Forwarded-SSL-Client-Cert $ssl_client_cert;
    
    
      ssl_certificate      /etc/ssl/certs/server.crt;
      ssl_certificate_key  /etc/ssl/certs/server.key;
    
    
      ssl_protocols        SSLv3 TLSv1;
      ssl_ciphers          RSA:!EXPORT:!DH:!LOW:!NULL:+MEDIUM:+HIGH;
    
        location / {
            root   /usr/share/nginx/html;
            index  index.html index.htm;
        }
    
        #error_page  404              /404.html;
    
        # redirect server error pages to the static page /50x.html
        #
        error_page   500 502 503 504  /50x.html;
        location = /50x.html {
            root   /usr/share/nginx/html;
        }
    
    }

To debug nginx `tail -f /var/log/nginx/error.log`

## Setup OpenShift Routing SPI

On the broker, install routing plugin

    $ yum install rubygem-openshift-origin-routing-activemq

Create the routing-plugin configuration file

    $ cp /etc/openshift/plugins.d/openshift-origin-routing-activemq.conf.example /etc/openshift/plugins.d/openshift-origin-routing-activemq.conf
    $ cat openshift-origin-routing-activemq.conf
    ACTIVEMQ_TOPIC='/topic/routinginfo'
    ACTIVEMQ_USERNAME='routinginfo'
    ACTIVEMQ_PASSWORD='routinginfopasswd'
    ACTIVEMQ_HOST='127.0.0.1'
    ACTIVEMQ_PORT='61613'

Add `routinginfo` user into `activemq.xml` configuration file. See files below.

            <!-- add users for mcollective -->
     
            <plugins>
              <statisticsBrokerPlugin/>
              <simpleAuthenticationPlugin>
                 <users>
                   <authenticationUser username="mcollective" password="marionette" groups="mcollective,everyone"/>
                   <authenticationUser username="admin" password="OF17WqWx4eKHbV2t8DjsjA==" groups="mcollective,admin,everyone"/>
    +              <authenticationUser username="routinginfo" password="routinginfopasswd" groups="routinginfo,everyone"/>
                 </users>
              </simpleAuthenticationPlugin>
              <authorizationPlugin>
                <map>
                  <authorizationMap>
                    <authorizationEntries>
                      <authorizationEntry queue=">" write="admins" read="admins" admin="admins" />
                      <authorizationEntry topic=">" write="admins" read="admins" admin="admins" />
                      <authorizationEntry topic="mcollective.>" write="mcollective" read="mcollective" admin="mcollective" />
                      <authorizationEntry queue="mcollective.>" write="mcollective" read="mcollective" admin="mcollective" />
    +                 <authorizationEntry topic="routinginfo.>" write="routinginfo" read="routinginfo" admin="routinginfo" />
    +                 <authorizationEntry queue="routinginfo.>" write="routinginfo" read="routinginfo" admin="routinginfo" />
                      <authorizationEntry topic="ActiveMQ.Advisory.>" read="everyone" write="everyone" admin="everyone"/>
                    </authorizationEntries>
                  </authorizationMap>
                </map>
              </authorizationPlugin>
            </plugins>

Restart `broker` and `activemq`

    $ /etc/init.d/openshift-broker restart
    $ /etc/init.d/activemq restart

Allow HA and custom ssl certificates for your user

    $ oo-admin-ctl-user -l admin --allowha true
    $ oo-admin-ctl-user -l admin --allowprivatesslcertificates true

## Run openshift-nginx-routing

    $ scl enable nodejs010 "./bin/openshift-nginx-routing"

## Test it

Create an app

    $ scl enable ruby193 "rhc create-app --app appname --type php-5.3 -s"

Make it HA

    $ curl -H"Content-Type:application/json"  -XPOST -d '{"event":"make-ha"}' -u "admin:admin" -k https://broker.example.com/broker/rest/application/527a1bc06892dff71c0000ba/events

Test with curl

    $ curl -H "Host: appname-test.example.com" localhost

Add an alias

    $ scl enable ruby193 "rhc alias add --app appname alias.com"

Test with curl

    $ curl -H "Host: alias.com" localhost

Add a certificate

    $ openssl genrsa -des3 -out server.key.pass 1024
    $ openssl rsa -in server.key.pass -out server.key
    $ openssl req -new -key server.key -out server.csr
    $ openssl x509 -req -days 365 -in server.csr -signkey server.key -out server.crt
    $ scl enable ruby193 "rhc alias-update-cert alias.com --certificate server.crt --private-key server.key --app appname"

Test with curl

    $ curl -k -H "Host: alias.com" https://localhost

## Generate rpm

    $ yum install tito
    $ tito build --rpm --test

## Update mongodb applications

If your OpenShift instances was created before the Routing SPI, and updated recently. MongoDB data does not contains group_instances.
You will have to upgrade mongodb data by calling the script, on the broker:

    $ ./scripts/oo-admin-ctl-routes

## Note

Right now openshift-nginx-routing only works with HA applications.

SSL passphrase are not supported, because it breaks nginx reload.

openshift-nginx-routing retrieve endpoints details on startup on MongoDB.

More informations could be found here : https://lists.openshift.redhat.com/openshift-archives/dev/2013-November/msg00057.html

Not tested on Fedora (TODO systemd init files)
