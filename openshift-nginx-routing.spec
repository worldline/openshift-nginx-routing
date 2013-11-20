%global routerdir %{_libdir}/openshift-nginx-routing

Name:           openshift-nginx-routing
Version:        0.3
Release:        1%{?dist}
Summary:        Generate nginx configurations files and reload nginx with receiving routes from the OpenShift Routing SPI
Source0:        https://github.com/worldline/%{name}/archive/master.tar.gz

Group:          Network/Daemons
BuildArch:      noarch
License:        Apache
URL:            http://worldline.com

%description
Generate nginx configurations files and reload nginx with receiving routes from the OpenShift Routing SPI

%prep
%setup -q

%build
%__rm %{name}.spec

%install
%__mkdir -p %{buildroot}%{routerdir}
%__cp -r * %{buildroot}%{routerdir}

%__mkdir -p %{buildroot}%{_sysconfdir}
%__cp conf/%{name}.conf %{buildroot}%{_sysconfdir}

#TODO systemd
%__mkdir -p %{buildroot}%{_initddir}
%__mv %{buildroot}%{routerdir}/init.d/* %{buildroot}%{_initddir}
%__rm -rf %{buildroot}%{routerdir}/init.d

%__mkdir -p %{buildroot}%{_sysconfdir}/logrotate.d
%__mv %{buildroot}%{routerdir}/logrotate.d/* %{buildroot}%{_sysconfdir}/logrotate.d/
%__rm -rf %{buildroot}%{routerdir}/logrotate.d

%files
%doc %{routerdir}/LICENSE
%doc %{routerdir}/README.md
%config(noreplace) %{_sysconfdir}/%{name}.conf

%{routerdir}

#TODO systemd
%{_initddir}/%{name}
%{_sysconfdir}/logrotate.d/%{name}

%changelog
* Wed Nov 20 2013 Filirom1 <filirom1@gmail.com> 0.3-1
- add logrotate script (filirom1@gmail.com)
- typo (filirom1@gmail.com)
- update package.json version (filirom1@gmail.com)

* Wed Nov 20 2013 Filirom1 <filirom1@gmail.com> 0.2-1
- new package built with tito


