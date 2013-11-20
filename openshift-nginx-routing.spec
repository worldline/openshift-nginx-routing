%global routerdir %{_libdir}/openshift-nginx-routing

Name:           openshift-nginx-routing
Version:        0.1
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


%files
%doc %{routerdir}/LICENSE
%doc %{routerdir}/README.md
%config(noreplace) %{_sysconfdir}/%{name}.conf

%{routerdir}

#TODO systemd
%{_initddir}/%{name}

%changelog

