# pkij
A CLI tool for injecting packages into a mono repo. Pkij allows you to inject packages located
outside of the root of a mono repo while keeping file in sync with the source location. This is very
useful when developing library packages as it allows you to keep the code for library packages in a 
separate git repo while you test the package in other repos without the need to continuously 
publish NPM updates.

## Install
``` sh
npm install -g @iyio/pkij
```

## CLI Arguments

``` txt
--inject        [path ...]      List of package source config files or paths to package directories to inject.
                        If no paths are provided a default value of "pkij-config.json" is used.


--eject         [path ...]      List of package source config files or paths to package directories to eject.
                                If no paths are provided a default value of "pkij-config.json" is used.

--dry-run
--dryRun                        If present a dry run is preformed and no changes to the filesystem is made

--link          mode            Controls how source files are linked. By default hard links are used.
                                Modes: hard-link, sym-link, copy

--git-ignore
--gitIgnore                     If present injected packages are not added to the root .gitignore

--ts-config
--tsConfig
--tsconfig      path            Path to a tsconfig file that will be modified to include the paths
                                of injected packages

--package-json
--packageJson   path            Path to a package.json file to add or remove dependencies from based
                                on injected packages

--skip-install                  If present npm installs will be skipped. By default if the package.json
                                file is modified pkij will run an `npm install` to update node_modules

--delete-unlinked               If present files that have become unlinked will be deleted allowing
                                relinking to occur. Be careful when using this option since it could
                                delete changes to files that have not be applied to linked source
                                files.

--ignore        [path ...]      A list of paths to ignore. The ignored paths will not be linked when
                                injecting packages

--verbose                       If present verbose logging will be enabled.

--help
-h                              Show help
```


## Config
Pkij config files contain the paths to packages to inject and optionally per package configuration.

``` ts
interface Config
{
    packages:Pkg[];
}

interface Pkg
{
    // The location of the package
    dir:string;

    // Name of the package as defined in the package's package.json file
    npmName?:string;

    // The destination where the package should be injected
    dest?:string;

    // Do not manually define. A key used to match against other packages.
    key?:string;

    // If true a tsconfig path will not be added to the host mono repo
    disableTsConfigPath?:boolean;

    // If true the injected package will not be added to the .gitignore file
    disableGitIgnore?:boolean;

    // If true the injected package will not causes changes to be made the root package.json file to be make
    disableNpmPackageUpdate?:boolean;

    // If true the package is a dev dependency
    isNpmDevDep?:boolean;

    // The installed npm version of the package
    installedNpmVersion?:string;

    // relative path to a index.ts or index.js file. Default = "src/index.ts"
    indexPath?:string;
}
```

## Examples

### Using default config file
Inject packages defined in pkij-config.json in the current directory

`./pkij-config.json`
``` json
{
    "packages":[
        {"dir":"../some-other-local-repo/packages/cool-lib"}
    ]
}
```

``` sh
# Inject
npx pkij --inject

# Eject
npx pkij --eject
```


### Using a package directory path

Injects the package at the given path
``` sh
# Inject
npx pkij --inject ../some-other-local-repo/packages/cool-lib

# Eject
npx pkij --eject ../some-other-local-repo/packages/cool-lib
```