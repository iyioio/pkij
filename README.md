# pkij
A single-file, zero-dependency CLI tool designed for managing monorepos. Pkij is distributed as a standalone JavaScript file, and has no direct dependencies.

With pkij, you can build, test, and publish NPM packages within a monorepo, as well as manage inter package dependencies and tsconfig and package.json references, and handle environment files. Its flexible CLI supports a wide range of arguments for customizing package management, linking strategies, and build processes, all without relying on external libraries or frameworks.

Pkij also allows you to inject packages located
outside of the root of your monorepo while keeping file in sync with the source location. This is very
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
                                If no paths are provided a default value of ".pkij.json" is used.


--eject         [path ...]      List of package source config files or paths to package directories to eject.
                                If no paths are provided a default value of ".pkij.json" is used.

--build         [path ...]      Builds packages. If no packages are specified all packages are built.
--build-peer-internal-only      If present only internal packages ( packages in the packages directory) will be peers
--build-individual-packages     If present individual packages will be built with tsc instead of building all projects in a single pass

--update-imports dir            Adds file extensions to all local inputs in the target directory

--migrate-nx-tsconfig           Migrates tsconfig files used in NX projects

--update-tsconfig               Updates all tsconfig references and other mono-repo properties

--list-deps                     Lists dependencies

--test          [path ...]      Tests the specified packages or all packages in the package directory
                                that are in the npm namespace or publish list if no packages are specified

--publish       [path ...]      Publishes the specified packages or all packages in the package directory
                                that are in the npm namespace or publish list if no packages are specified

--publish-no-build              Disables automatic building before publishing

--set-version  [version]        Sets the version of all package.json files. If no version is supplied the all versions are increased by 0.0.1.

--create-lib   name             Creates a new library package

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
                                file is modified pkij will run an \`npm install\` to update node_modules

--delete-unlinked               If present files that have become unlinked will be deleted allowing
                                relinking to occur. Be careful when using this option since it could
                                delete changes to files that have not be applied to linked source
                                files.

--ignore        [path ...]      A list of paths to ignore. The ignored paths will not be linked when
                                injecting packages

--run        [[pkg]:name ...]   Runs a script by name. If a pkg is supplied the script will be searched
                                for in the packages directory. If pkg does not contain a slash a
                                path of "packages/{pkg}" will be used. If pkg is not supplied the
                                root of the project is used as the package directory

                                Scripts will be search for in the following order in the packages directory:
                                1. Inside the scripts object of a .pkij file
                                2. Inside the scripts object of a package.json and will be executed
                                   using npm run {name}
                                3. A shell file named {name}.sh
                                4. A shell file named scripts/{name}.sh

--env          [pathOrName ...] Path or name of .env files to load. If no period or slash is in the
                                value is treated as a name and a file of .env.{name} or .env-{name}
                                will be searched for in the current directory.
                                By default .env, .env.local, .env.secrets and .env.local-secrets are
                                loaded.

--disable-branch-env            Disables loading .env.branch-{current git branch}

--clear-env                     Clears all loaded env files including defaults. (note) The position
                                of this argument is important and only clears envs loaded before
                                the positions of this argument.

--clean                         Clears the dist, .pkij and all .next directories

--yes                           Answers yes for all interactive prompts 

--verbose                       If present verbose logging will be enabled.
```


## Config
Pkij config files contain the paths to packages to inject and optionally per package configuration.

``` js
/**
 * @typedef Config
 * @prop {'lib'|'nextjs'|'cdk'|'test'|'repo'|undefined} type
 * @prop {Pkg[]|undefined} inject Packages to inject
 * @prop {string[]|undefined} ignore
 * @prop {BuildConfig|undefined} build
 * @prop {boolean|undefined} disabled
 * @prop {Record<string,any>} binBuildOptions ESBuild options used for building bin executables
 * @prop {string|undefined} namespace NPM namespace
 * @prop {string[]|undefined} additionalNamespaces Additional npm namespaces
 * @prop {string[]|undefined} publishList List of packages to publish in addition to packages with the same namespace as the namespace prop
 * @prop {boolean|undefined} excludeNamespaceFromBuildList If true packages with the same namespace as the namespace prop will not be automatically included in the publishList
 *
 * @typedef Pkg
 * @prop {string} dir The location of the package
 * @prop {string|undefined} npmName Name of the package as defined in the package's package.json file
 * @prop {string|undefined} dest The destination where the package should be injected
 * @prop {string|undefined} key Do not manually define. A key used to match against other packages.
 * @prop {boolean|undefined} disableTsConfigPath If true a tsconfig path will not be added to the host mono repo
 * @prop {boolean|undefined} disableGitIgnore If true the injected package will not be added to the .gitignore file
 * @prop {boolean|undefined} disableNpmPackageUpdate If true the injected package will not causes changes to be made the root package.json file to be make
 * @prop {boolean|undefined} isNpmDevDep If true the package is a dev dependency
 * @prop {string|undefined} installedNpmVersion The installed npm version of the package
 * @prop {string|undefined} indexPath relative path to a index.ts or index.js file. Default = "src/index.ts"
 * @prop {Record<string,any>} packageJson Package json
 * @prop {Record<string,any>} tsConfig tsconfig json
 * @prop {string|undefined} tsConfigPath Path to tsconfig file relative to root of project
 * @prop {Record<string,string>} scripts Direct package dependencies
 * @prop {string[]} deps Direct package dependencies
 * @prop {string[]} externalDeps external deps
 * @prop {string[]|undefined} assets markdown files and images
 * @prop {Config|undefined} config additional configuration
 * @prop {string|undefined} binDir A directory where bin commands should be compiled from
 * @prop {boolean|undefined} disablePublish Disables NPM publishing
 */
```

## Examples

### Inject package from outside of root
This example injects a package called cool-lib from a local repo called awesome-tools into 
the working monorepo. The source code for cool-lib will be hard linked to the `packages/cool-lib`
directly within the current monorepo

`.pkij.json`
``` json
{
    "inject":[
        {"dir":"../awesome-tools/packages/cool-lib"}
    ]
}
```

``` sh
# Inject
npx pkij --inject

# Eject
npx pkij --eject
```


