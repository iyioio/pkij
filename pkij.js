#!/usr/bin/env node
"use strict";

const child_process = require("node:child_process");
const fs = require("node:fs/promises");
const Path = require("node:path");
const readline = require('readline');

/**
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
 *
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
 * @typedef BuildConfig
 * @prop {boolean|undefined} disabled
 *
 * @typedef ScriptTarget
 * @prop {string} name
 * @prop {string} dir
 */

const pkijConfigFileName='.pkij.json'

const mergePkgProps=['isNpmDevDep','installedNpmVersion'];

const currentPkgFile='.pkij-injected-packages.json';

let dryRun=false;
/** @type {'hard-link'|'sym-link'|'copy'} */
let linkMode='hard-link';
const linkModes=['hard-link','sym-link','copy'];

/** @type {string[]} */
const ignoreList=['.DS_Store','node_modules','venv','__pycache__','.convo-make','.next','dist'];

let gitIgnoreFile='.gitignore';
let tsConfigFile='tsconfig.base.json';
let packageJsonFile='package.json';
let buildPeerInternalOnly=false;

let updateImports=null;

let packageJsonFileChanged=false;
let verbose=false;
let skipNpmInstall=false;
let deleteUnlinked=false;

let migrateNxTsConfig=false;
let publishPackages=false;
let setVersion=undefined;
let createLib=undefined;
let listDeps=false;
let yes=false;
let publishNoBuild=false;
let cleanProject=false;
let runTests=undefined;
let minOutput=false;
const loadEnvs=['.env','.env.local','.env.secrets','.env.local-secrets'];
/** @type {ScriptTarget[]} */
const scriptTargets=[];


const main=async ()=>{

    /**
    * Packages to be injected
    * @type {Record<string,Pkg>}
    */
    const inject={};

    /**
    * Packages to be ejected
    * @type {Record<string,Pkg>}
    */
    const eject={};

    const addInjectedToAsync=async (dic,path)=>{
        /** @type {Pkg[]} */
        const pkgs=await getInjectedPkgsAsync(path);
        for(const p of pkgs){
            let abs=(await fs.realpath(p.dir)).toLowerCase();
            if(abs.endsWith('/')){
                abs=abs.substring(0,abs.length-1);
            }
            if(!dic[abs]){
                dic[abs]=p;
            }
        }
    }

    let hasAction=false;
    let publishList=undefined;

    const initBuildAsync=async (nextAll)=>{
        hasAction=true;
        const dirs=nextAll.length?nextAll.map(d=>(!d.includes('/') && !d.includes('\\'))?'packages/'+d:d):await getBuildPackagePathsAsync();
        if(nextAll.length){
            buildIndividualPackages=true;
        }
        for(const d of dirs){
            if(!buildPaths.includes(d)){
                buildPaths.push(d);
            }
        }
    }

    for(let i=0;i<process.argv.length;i++){

        /** @type {string[]} */
        const nextAll=[];
        for(let n=i+1;n<process.argv.length;n++){
            const next=process.argv[n];
            if(next.startsWith('--')){
                break;
            }
            nextAll.push(next);
        }

        const next=nextAll[0]??'';

        const currentArg=process.argv[i]
        switch(currentArg){

            case '--inject':
                hasAction=true;
                if(nextAll.length){
                    for(const n of nextAll){
                        await addInjectedToAsync(inject,n);
                    }
                }else{
                    await addInjectedToAsync(inject,pkijConfigFileName);
                }
                break;

            case '--eject':
                hasAction=true;
                if(nextAll.length){
                    for(const n of nextAll){
                        await addInjectedToAsync(eject,n);
                    }
                }else{
                    await addInjectedToAsync(eject,pkijConfigFileName);
                }
                break;

            case '--env':
                for(const e of nextAll){
                    loadEnvs.push((e.includes('.') || e.includes('/') || e.includes('\\'))?e:`.env.${e}`);
                }
                break;

            case '--clear-env':
                loadEnvs.splice(0,loadEnvs.length);
                break;
            
            case '--yes':
                yes=true;
                break;
            
            case '--clean':
                cleanProject=true;
                hasAction=true;
                break;

            case '--create-lib':
                createLib=next;
                hasAction=true;
                break;

            case '--publish':
                publishPackages=true;
                hasAction=true;
                await initBuildAsync(nextAll);
                if(nextAll.length){
                    publishList=nextAll;
                }else{
                    publishList=[...buildPaths];
                }
                break;

            case '--publish-no-build':
                publishNoBuild=true;
                break;

            case '--build':
                await initBuildAsync(nextAll);
                break;

            case '--build-peer-internal-only':
                buildPeerInternalOnly=true;
                break;

            case '--build-individual-packages':
                buildIndividualPackages=true;
                break;

            case '--update-tsconfig':
                updateTsConfigs=true;
                hasAction=true;
                break;

            case '--update-imports':
                if(next){
                    updateImports=next;
                    hasAction=true;
                }
                break;

            case '--list-deps':
                listDeps=true;
                hasAction=true;
                break;

            case '--set-version':
                setVersion=next||'+0.0.1';
                hasAction=true;
                break;

            case '--test':
                runTests=nextAll.length?nextAll:true;
                hasAction=true;
                updateTsConfigs=true;
                break;

            case '--run':
                hasAction=true;
                minOutput=true;
                for(const t of nextAll){
                    const i=t.indexOf(':');
                    if(i===-1){
                        scriptTargets.push({name:t,dir:'.'})
                    }else{
                        const p=t.substring(0,i);
                        scriptTargets.push({name:t.substring(i+1),dir:(p.includes('/') || p.includes('\\'))?p:`packages/${p}`})
                    }
                }
                break;

            case '--migrate-nx-tsconfig':
                migrateNxTsConfig=true;
                hasAction=true;
                break;

            case '--dry-run':
            case '--dryRun':
                console.log('dry-run');
                dryRun=true;
                yes=true;
                break;

            case '--link':
                if(linkModes.includes(next)){
                    throw new Error(`Invalid link mode. modes = ${linkMode.join(', ')}`)
                }
                linkMode=next;
                console.info(`link mode set to "${linkMode}"`)
                break;

            case '--git-ignore':
            case '--gitIgnore':
                if(next){
                    gitIgnoreFile=next;
                }
                break;

            case '--ts-config':
            case '--tsConfig':
            case '--tsconfig':
                if(next){
                    tsConfigFile=next;
                }
                break;

            case '--package-json':
            case '--packageJson':
                if(next){
                    packageJsonFile=next;
                }
                break;

            case '--skip-install':
            case '--skipInstall':
                skipNpmInstall=true;
                break;

            case '--delete-unlinked':
            case '--deleteUnlinked':
                deleteUnlinked=true;
                break;


            case '--ignore':
                if(next){
                    ignoreList.push(...nextAll);
                }
                break;

            case '--verbose':
                verbose=true;
                break;

            case '--help':
            case '-h':
                showUsage();
                process.exit(0);

            default:
                if(currentArg.startsWith('--')){
                    throw new Error(`Unknown argument: ${currentArg}`);
                }
                break;

        }
    }

    if(verbose){
        minOutput=false;
    }

    if(!hasAction){
        showUsage();
        process.exit(1);
    }

    if(!minOutput){
        console.info('pkij config',{
            dryRun,
            verbose,
            packageJsonFile,
            gitIgnoreFile,
            tsConfigFile,
            ignoreList,
            skipNpmInstall,
            buildPaths,
            loadEnvs,
        });
    }

    for(const env of loadEnvs){
        await loadEnvAsync(env);
    }

    if(cleanProject){
        await cleanProjectAsync();
    }

    for(const absPath in inject){
        await injectAsync(inject[absPath]);
        updateTsConfigs=true;
    }

    for(const absPath in eject){
        await ejectAsync(eject[absPath]);
        updateTsConfigs=true;
    }

    if(updateTsConfigs){
        await loadBuildPackagesAsync();
        await updateTsConfigsAsync();
    }

    if(listDeps){
        await listDepsAsync();
    }

    if(buildPaths.length && !(publishPackages && publishNoBuild)){
        await buildAsync();
    }

    if(updateImports){
        await updateImportsAsync(updateImports);
    }

    if(migrateNxTsConfig){
        await migrateNxTsConfigAsync();
    }

    if(runTests){
        await runTestsAsync(runTests);
    }

    if(setVersion){
        await setVersionAsync(setVersion);
    }

    if(publishPackages){
        await publishPackagesAsync(publishList);
    }

    if(createLib){
        await createLibAsync(createLib);
    }

    if(packageJsonFileChanged && !skipNpmInstall){
        console.info('Changes to package.json made. Running npm install')
        if(!dryRun){
            await execAsync('npm',['install']);
        }
    }

    if(scriptTargets.length){
        for(const t of scriptTargets){
            await runScriptAsync(t);
        }
    }

    if(!minOutput){
        console.log('pkij done');
    }
}

/**
 * @param {ScriptTarget} target 
 */
const runScriptAsync=async (target)=>{

    const tryRunObjScriptAsync=async (filePath)=>{
        const obj=await loadJsonOrDefaultAsync(filePath,null);
        let script=obj?.scripts?.[target.name];
        if(script){
            if(verbose){
                console.log(`run ${filePath}{.scripts[${target.name}]}`)
            }
            await spawnAsync({
                dryRun,
                cmd:script,
                cwd:target.dir,
                exitWithErrorCode:true,
            });
            return true;
        }else{
            return false;
        }
    }

    const tryRunShellFileAsync=async (filePath)=>{
        if(!await existsAsync(filePath)){
            return false;
        }
        if(verbose){
            console.log(`run ${filePath}`)
        }
        await spawnAsync({
            dryRun,
            cmd:`./${Path.basename(filePath)}`,
            cwd:Path.dirname(filePath),
            exitWithErrorCode:true,
        });
        return true;
    }

    if(await tryRunObjScriptAsync(Path.join(target.dir,pkijConfigFileName))){
        return;
    }

    if(await tryRunObjScriptAsync(Path.join(target.dir,'package.json'))){
        return;
    }
    
    if(await tryRunShellFileAsync(Path.join(target.dir,`${target.name}.sh`))){
        return;
    }
    
    if(await tryRunShellFileAsync(Path.join(target.dir,'scripts',`${target.name}.sh`))){
        return;
    }

    throw new Error(`No script found by target - ${target.dir}:${target.name}`);
}

/**
 * @param {string} path 
 */
const loadEnvAsync=async (path)=>{
    const text=await loadTextOrDefaultAsync(path,'');
    if(path.toLowerCase().endsWith('.json')){
        const obj=JSON.parse(text);
        for(const e in obj){
            const v=obj[e];
            if(v===null || v===undefined){
                continue;
            }
            if(verbose){
                console.log(`env ${path}:${e}`);
            }
            if(typeof v === 'object'){
                process.env[e]=JSON.stringify(v);
            }else{
                process.env[e]=v+'';
            }
        }
    }else{
        const lines=text.split('\n').map(l=>l.trim());
        for(const line of lines){
            if(!line || line.startsWith('#')){
                continue;
            }
            const i=line.indexOf('=');
            if(i===-1){
                continue;
            }
            const name=line.substring(0,i).trim();
            const value=line.substring(i+1).trim();
            if(verbose){
                console.log(`env ${path}:${name}`);
            }
            process.env[name]=value;
        }
    }
}

/**
 * Reads a line of text from the terminal
 * @param {string} message
 * @returns {Promise<string>}
 */
const promptAsync=(message)=>{
    const rl=readline.createInterface({
        input:process.stdin,
        output:process.stdout
    });

    return new Promise((resolve)=>{

        rl.question(message+' ',(value)=>{
            rl.close();
            resolve(value);
        });
    })
}
/**
 * @param {string} message 
 * @returns {Promise<boolean>}
 */
const promptYesNoAsync=async (message)=>{
    const r=await promptAsync(message+' [y/N]');
    return r.trim().toLowerCase()==='y';
}


/**
 * Executes a shell command
 * @param {string} cmd
 * @param {string[]} args
 * @param {boolean} silent
 * @returns {Promise<number>}
 */
const execAsync=(
    cmd,
    args,
    silent=false,
)=>{
    return new Promise((r,j)=>{
        if(!silent){
            console.info('> '+cmd);
        }
        const proc=child_process.spawn(cmd,args,{stdio:silent?'pipe':[process.stdin,process.stdout,process.stderr]});

        proc.on('close',(code)=>{
            if(code!==0){
                j(`process existed with ${code}`);
            }else{
                r(code);
            }
        });

    })
}


/**
 * @typedef SpawnOptions
 * @prop {string} cmd
 * @prop {string|undefined} cwd
 * @prop {(value:string)=>void|undefined} out
 * @prop {string|undefined} outPrefix
 * @prop {boolean|undefined} silent
 * @prop {boolean|undefined} throwOnError
 * @prop {((...value:string[])=>void)|undefined} stdout
 * @prop {((...value:string[])=>void)|undefined} stderr
 * @prop {((proc:ChildProcess)=>void)|undefined} onChild
 * @prop {((type:string,value:string)=>void)|undefined} onOutput
 * @prop {((type:string,value:string)=>void)|undefined} onError
 * @prop {((code:number)=>void)|undefined} onExit
 * @prop {CancelToken|undefined} cancel
 * @prop {boolean|undefined} logPid
 * @prop {boolean|undefined} dryRun
 * @prop {boolean|undefined} exitWithErrorCode
 */


/**
 * Executes a shell command and returns its output
 * @param {SpawnOptions} options
 * @returns {Promise<string>}
 */
const spawnAsync=(
    options
)=>{
    const {
        cmd,
        cwd,
        out,
        silent,
        stdout=(...args)=>minOutput?process.stdout.write(args.join('')):console.log(...args),
        stderr=console.error,
        onChild,
        onOutput,
        onError,
        outPrefix='',
        throwOnError=true,
        exitWithErrorCode=false,
        onExit,
        cancel,
        logPid,
        dryRun,
    }=options;

    if(dryRun){
        console.log(`[dry_run] ${cwd||'.'}> ${cmd}`);
        return Promise.resolve('');
    }

    return new Promise((r,j)=>{

        let child=undefined;
        const outData=[];

        try{
            child=child_process.spawn(cmd,{cwd,shell:true});
            if(logPid){
                if(!silent){
                    stdout?.(`pid(${child.pid}) > `+cmd);
                }
                out?.(`pid(${child.pid}) > `+cmd)
            }else{
                if(!silent && !minOutput){
                    stdout?.('> '+cmd);
                }
                out?.('> '+cmd)
            }
        }finally{
            if(!child){
                if(!silent){
                    stdout?.('> '+cmd);
                }
                out?.('> '+cmd)
            }
        }
        child.on('error',err=>{
            if(throwOnError){
                j(err);
            }
        });
        child.on('exit',code=>{
            if(logPid){
                if(!silent){
                    stdout?.(`pid(${child?.pid}) > # exit(${code}) -- `+cmd);
                }
                out?.(`pid(${child?.pid}) > # exit(${code}) -- `+cmd)
            }
            onExit?.(code??0);
            if(code && exitWithErrorCode){
                process.exit(code);
            }else if(code && throwOnError){
                j(code);
            }else{
                r(outData.join());
            }
        });
        child.on('disconnect',()=>r(outData.join()));
        child.on('close',()=>r(outData.join()));
        child.stdout.setEncoding('utf8');
        child.stdout.on('data',(data)=>{
                
            if(typeof data !== 'string'){
                data=data?.toString()??''
            }
            outData.push(data);
            if(onOutput){
                onOutput('out',data)
            }
            out?.(data);
            if(!silent){
                stdout?.(outPrefix?outPrefix+data:data);
            }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data',(data)=>{
            if(typeof data !== 'string'){
                data=data?.toString()??''
            }
            if(onError){
                onError('err',data)
            }
            out?.(data);
            stderr?.(outPrefix?outPrefix+data:data);
        });
        onChild?.(child);
        cancel?.onCancelOrNextTick(()=>{
            try{
                child?.kill();
            }catch{
                // do nothing
            }
        });
    })
}



/**
 * Get package info from either a config file path or package directory path
 * @param {string} path
 & @returns {Promise<Pkg[]>}
 */
const getInjectedPkgsAsync=async (path)=>{

    try{

        /** @type {Pkg[]} */
        const pkgs=[];

        const stat=await fs.stat(path);

        if(stat.isFile()){
            /** @type {Config} */
            const config=await loadJsonAsync(path);
            if(config.ignore){
                ignoreList.push(...config.ignore);
            }
            for(const pkg of config.inject){
                await populatePkgAsync(pkg);
                pkgs.push(pkg);
            }
        }else{
            /** @type {Pkg} */
            const pkg={dir:path}
            await populatePkgAsync(pkg);
            pkgs.push(pkg);
        }

        return pkgs;
    }catch(ex){
        console.error(`Unable to get package info from ${path}`,ex);
        throw ex;
    }
}

/**
 * Checks if a path exists
 * @param {string} path
 * @returns {Promise<boolean>}
 */
const existsAsync=async (path)=>{
    try{
        await fs.access(path);
        return true;
    }catch{
        return false;
    }
}

/**
 * Checks if a path exists
 * @param {string} path
 * @returns {Promise<boolean>}
 */
const isDirAsync=async (path)=>{
    if(!await existsAsync(path)){
        return false;
    }
    const s=await fs.stat(path);
    return s.isDirectory();
}

/**
 * Populates properties of a Pkg
 * @param {Pkg} pkg
 */
const populatePkgAsync=async (pkg)=>{
    const packageJsonPath=Path.join(pkg.dir,'package.json');
    const tsConfigPath=Path.join(pkg.dir,'tsconfig.json');
    const configPath=Path.join(pkg.dir,pkijConfigFileName);
    await Promise.all([
        (async ()=>{
            if(await existsAsync(packageJsonPath)){
                const packageJson=await loadJsonAsync(packageJsonPath);
                if((typeof packageJson.name === 'string') && !pkg.npmName){
                    pkg.npmName=packageJson.name;
                }
                pkg.packageJson=packageJson;
            }
        })(),
        (async ()=>{
            if(await existsAsync(configPath)){
                const configJson=await loadJsonAsync(configPath);
                pkg.config=configJson;
            }
        })(),
        (async ()=>{
            if(await existsAsync(tsConfigPath)){
                const tsConfig=await loadJsonAsync(tsConfigPath);
                pkg.tsConfig=tsConfig;
                pkg.tsConfigPath=tsConfigPath;
            }
        })(),
    ])
    
    
    if(!pkg.dest){
        pkg.dest=`packages/${Path.basename(pkg.dir)}`;
    }
    pkg.key=pkg.dest.toLowerCase();
    if(pkg.key.endsWith('/')){
        pkg.key=pkg.key.substring(0,pkg.key.length-1);
    }
    if(pkg.npmName && !pkg.indexPath){
        pkg.indexPath='src/index.ts';
    }
    
}

/**
 * Populates the dependencies of a Pkg
 * @param {Pkg} pkg
 * @param {Record<string,any>} rootBuildPackageJson
 * @param {Record<string,any>} rootTsConfig
 */
const populatePkgPass2Async=async (pkg,rootBuildPackageJson,rootTsConfig)=>{
    const {deps,externalDeps,assets,binDir}=await scanPackageAsync(pkg,rootBuildPackageJson,rootTsConfig);

    const packageJson={...pkg.packageJson}
    for(const name of deps){
        const peer=buildPeerInternalOnly?((rootTsConfig?.compilerOptions?.paths?.[name] || rootBuildPackageJson?.peerDependencies?.[name])?true:false):true;
        const depName=peer?'peerDependencies':'dependencies';
        if(!packageJson[depName]){
            packageJson[depName]={};
        }
        const localPeer=buildPkgs.find(p=>p.npmName===name);
        const version=(
            rootBuildPackageJson?.peerDependencies?.[name]??
            rootBuildPackageJson?.dependencies?.[name]??
            (localPeer?.packageJson?.version?'^'+localPeer.packageJson.version:null)??
            null
        )
        if(version!==null){
            packageJson[depName][name]=version;
        }
    }
    pkg.packageJson=packageJson;
    pkg.deps=deps;
    pkg.externalDeps=externalDeps;
    pkg.assets=assets;
    pkg.binDir=binDir;
}


const getModeTimeAsync=async (path,exists,min,timeRef)=>{
    if(exists===undefined){
        exists=await existsAsync(path);
    }
    if(!exists){
        return;
    }
    const info=await fs.stat(path);
    const time=Math.max(info.ctimeMs,info.mtimeMs);
    if(timeRef.time===undefined || (min?time<timeRef.time:time>timeRef.time)){
        timeRef.time=time;
    }
}

/**
 * Builds a package
 * @param {Pkg} pkg
 * @param {Record<string,any>} rootBuildPackageJson
 * @param {Record<string,any>} rootTsConfig
 * @returns {Promise<{deps:string[],externalDeps:string[],assets:string[],binDir:string|undefined>}
 */
const scanPackageAsync=async (pkg,rootBuildPackageJson,rootTsConfig)=>{

    const deps=[];
    const externalDeps=[];
    const assets=[];

    const binDir=Path.join(pkg.dir,'src/bin');
    const binPromise=existsAsync(binDir);

    const {outDir}=getPkgOut(pkg);

    const promises=[];
    
    await scanDirAsync(pkg.dir,outDir,async (name,srcPath,destPath,isDir)=>{
        if(isDir){
            return;
        }

        if(tsReg.test(name) && !name.includes('.spec.')){
            const file=await loadTextAsync(srcPath);
            findDeps(file,importReg,2,deps,externalDeps,rootBuildPackageJson,rootTsConfig);
            findDeps(file,requireReg,2,deps,externalDeps,rootBuildPackageJson,rootTsConfig);
        }

        const e=name.lastIndexOf('.');
        const ext=e===-1?'':name.substring(e+1);

        if(assetsExtensions.includes(ext)){
            assets.push(srcPath);
        }

    });

    await Promise.all(promises);

    deps.sort();
    assets.sort();

    return {
        deps,
        externalDeps,
        assets,
        binDir:(await binPromise)?binDir:undefined
    };
}


/**
 * Reads a file as a string
 * @param {string} path
 * @returns {Promise<string>}
 */
const loadTextAsync=async (path)=>{
    try{
        return (await fs.readFile(path)).toString();
    }catch(ex){
        console.error(`Unable to load or parse ${path}`,ex);
        throw ex;
    }
}

/**
 * Reads a file as a JSON object
 * @param {string} path
 * @returns {Promise<any>}
 */
const loadJsonAsync=async (path)=>{
    try{
        return JSON.parse((await fs.readFile(path)).toString());
    }catch(ex){
        console.error(`Unable to load or parse ${path}`,ex);
        throw ex;
    }
}

/**
 * Reads a file as a JSON object or returns a default value if the file does not exist
 * @param {string} path
 * @param {any} defaultValue
 * @returns {Promise<any>}
 */
const loadJsonOrDefaultAsync=async (path,defaultValue)=>{
    if(!await existsAsync(path)){
        return defaultValue
    }
    return await loadJsonAsync(path);
}

/**
 * Reads a file as a string or returns a default value if the file does not exist
 * @param {string} path
 * @param {string} defaultValue
 * @returns {Promise<string>}
 */
const loadTextOrDefaultAsync=async (path,defaultValue)=>{
    if(!await existsAsync(path)){
        return defaultValue;
    }
    return await loadTextAsync(path);
}

/**
 * Recursively scans a directory
 * @param {string} dir
 * @param {string} dest
 * @param {(name:string,srcPath:string,destPath:string,isDir:boolean)=>void|Promise<void>} fileCallback
 */
const scanDirAsync=async (dir,dest,fileCallback)=>{
    const paths=await fs.readdir(dir,{withFileTypes:true});

    for(const f of paths){
        const srcPath=Path.join(dir,f.name);
        const destPath=Path.join(dest,f.name);
        if(ignoreList.includes(f.name)){
            if(verbose){
                console.log(`ignore: ${srcPath}`);
            }
            continue;
        }
        const isDir=f.isDirectory();
        await fileCallback(f.name,srcPath,destPath,isDir);
        if(isDir){
            await scanDirAsync(srcPath,destPath,fileCallback);
        }
    }
}

/**
 * @param {Pkg} pkg
 * @param {Pkg} currentPkg
 */
const mergePackages=(pkg,currentPkg)=>{
    for(const p of mergePkgProps){
        if(!pkg[p] && currentPkg[p]){
            pkg[p]=currentPkg[p];
        }
    }
}

const isLinkedAsync=async (srcPath,destPath)=>{
    let linked=false;
    switch(linkMode){

        case 'hard-link':{
            const [srcStat,destStat]=await Promise.all([
                fs.stat(srcPath),
                fs.stat(destPath),
            ]);
            linked=srcStat.ino===destStat.ino;
        }
        default:{
            const destBuf=await fs.readFile(destPath);
            const srcBuf=await fs.readFile(srcPath);
            linked=destBuf.equals(srcBuf);
            break;
        }
    }
    return linked;
}

/**
 * Injects a package
 * @param {Pkg} pkg
 */
const injectAsync=async (pkg)=>{
    console.info('inject',verbose?pkg:`${pkg.dir} -> ${pkg.dest}`);

    const dirExists=await isDirAsync(pkg.dir);
    if(!dirExists){
        throw new Error(`Package ${pkg.dir} is not a directory`);
    }

    if(!pkg.dest){
        throw new Error(`Package ${pkg.dir} dest not defined`)
    }
    const destExists=await isDirAsync(pkg.dest);

    /** @type {Pkg[]} */
    const currentPackages=await loadJsonOrDefaultAsync(currentPkgFile,[]);
    const currentIndex=currentPackages.findIndex(c=>c.key===pkg.key);
    const current=currentPackages[currentIndex];

    if(destExists && !current){
        throw new Error(
            `Package ${pkg.dir} dest already exists but is not in the current injected package list. `+
            `Continuing with injection could lead to overwriting non-injected files.`
        )
    }

    if(!pkg.disableGitIgnore){
        const content=await loadTextOrDefaultAsync(gitIgnoreFile)
        const ignoreLines=content.split('\n').map(s=>s.trim());
        const igPath='/'+pkg.dest;
        if(!ignoreLines.includes(igPath)){
            console.info(`ignore: ${igPath}`);
            if(!dryRun){
                await fs.appendFile(gitIgnoreFile,(content.endsWith('\n')?'':'\n')+igPath+'\n');
            }
        }

    }

    if(!destExists){
        console.info(`mkdir: ${pkg.dest}`);
        if(!dryRun){
            await fs.mkdir(pkg.dest,{recursive:true});
        }
    }

    await scanDirAsync(pkg.dir,pkg.dest,async (name,srcPath,destPath,isDir)=>{
        const exists=await existsAsync(destPath);
        if(isDir){
            if(!exists){
                console.info(`mkdir: ${destPath}`);
                if(!dryRun){
                    await fs.mkdir(destPath,{recursive:true});
                }
            }
        }else{
            if(!exists || verbose){
                console.info(`link: ${linkMode} - ${srcPath} -> ${destPath}`);
            }
            if(exists){
                if(await isLinkedAsync(srcPath,destPath)){
                    return;
                }else{
                    console.warn(`\x1b[33mBroken link detected: ${srcPath} -> ${destPath}\x1b[0m`);
                    if(deleteUnlinked){
                        console.log(`\x1b[31mdelete: ${destPath}\x1b[0m`);
                        if(!dryRun){
                            await fs.unlink(destPath);
                        }
                    }else{
                        console.log('use the --delete-unlinked flag to auto delete broken links');
                        return;
                    }
                }
            }
            if(!dryRun){
                switch(linkMode){

                    case 'hard-link':
                        await fs.link(srcPath,destPath);
                        break;

                    case 'sym-link':
                        await fs.symlink(srcPath,destPath);
                        break;

                    case 'copy':
                        await fs.copyFile(srcPath,destPath);
                        break;
                }
            }
        }
    })

    if(!pkg.disableTsConfigPath && pkg.npmName){
        const tsConfig=await loadJsonOrDefaultAsync(tsConfigFile,{});
        if(!tsConfig.compilerOptions){
            tsConfig.compilerOptions={}
        }
        if(!tsConfig.compilerOptions.paths){
            tsConfig.compilerOptions.paths={};
        }
        /** @type {Record<string,string[]>} */
        const paths=tsConfig.compilerOptions.paths;

        if(!paths[pkg.npmName]){
            paths[pkg.npmName]=[];
        }

        const index=Path.join(pkg.dest,pkg.indexPath??'');
        const included=paths[pkg.npmName].includes(index)
        if(!included){
            console.info(`addTsPath: ${pkg.npmName}::${index}`);
            paths[pkg.npmName].push(index);
            paths[pkg.npmName].sort();
        }

        sortRecordKeys(paths);

        if(!dryRun && !included){
            await fs.writeFile(tsConfigFile,JSON.stringify(tsConfig,null,4));
        }

    }

    if(!pkg.disableNpmPackageUpdate && pkg.npmName){
        const packageJson=await loadJsonOrDefaultAsync(packageJsonFile,{});
        const deps=packageJson.dependencies;
        const devDeps=packageJson.devDependencies;
        let changed=false;
        if(deps?.[pkg.npmName]){
            console.info(`removeNpmDep: ${pkg.npmName}`);
            pkg.installedNpmVersion=deps[pkg.npmName];
            delete deps[pkg.npmName];
            changed=true;
        }
        if(devDeps?.[pkg.npmName]){
            console.info(`removeNpmDevDep: ${pkg.npmName}`);
            pkg.installedNpmVersion=devDeps[pkg.npmName];
            delete devDeps[pkg.npmName];
            pkg.isNpmDevDep=true;
            changed=true;
        }

        if(changed){
            packageJsonFileChanged=true;
            if(!dryRun){
                await fs.writeFile(packageJsonFile,JSON.stringify(packageJson,null,4));
            }
        }

    }

    if(current){
        mergePackages(pkg,current);
    }


    if(currentIndex===-1){
        currentPackages.push(pkg);
    }else{
        currentPackages[currentIndex]=pkg;
    }
    if(!dryRun){
        await fs.writeFile(currentPkgFile,JSON.stringify(currentPackages,null,4));
    }
}

/**
 * Sorts the keys of a record
 * @param {Record<string,any>|undefined|null} rec
 */
const sortRecordKeys=(rec)=>{
    if(!rec){
        return;
    }
    const dup={...rec}
    const keys=Object.keys(rec);
    keys.sort();
    for(const k of keys){
        delete rec[k];
    }

    for(const k of keys){
        rec[k]=dup[k];
    }

}

/**
 * Ejects a package
 * @param {Pkg} pkg
 */
const ejectAsync=async (pkg)=>{
    console.info('eject',pkg);

    const dirExists=await isDirAsync(pkg.dir);
    if(!dirExists){
        throw new Error(`Package ${pkg.dir} is not a directory`);
    }

    if(!pkg.dest){
        throw new Error(`Package ${pkg.dir} dest not defined`)
    }
    const destExists=await isDirAsync(pkg.dest);

    /** @type {Pkg[]} */
    const currentPackages=await loadJsonOrDefaultAsync(currentPkgFile,[]);
    const currentIndex=currentPackages.findIndex(c=>c.key===pkg.key);
    const current=currentPackages[currentIndex];

    if(destExists && !current){
        throw new Error(
            `Package ${pkg.dir} eject dest exists but is not in the current injected package list. `+
            `Continuing with ejection could lead to overwriting non-injected files.`
        )
    }

    if(destExists){
        // reverse dest and source
        await scanDirAsync(pkg.dest,pkg.dir,async (name,destPath,srcPath,isDir)=>{
            if(isDir){
                return;
            }
            if(!await existsAsync(srcPath)){
                throw new Error(`Found an unlinked file in ejecting package. File does not exists in package source - (missing) ${srcPath} -> ${destPath}`);
            }
            if(!await isLinkedAsync(srcPath,destPath)){
                throw new Error(`Unlinked file detected. Can not eject or risk losing changes. ${srcPath} -> ${destPath}`);
            }
        });
    }

    if(!pkg.disableTsConfigPath && pkg.npmName){
        const tsConfig=await loadJsonOrDefaultAsync(tsConfigFile,{});
        if(!tsConfig.compilerOptions){
            tsConfig.compilerOptions={}
        }
        if(!tsConfig.compilerOptions.paths){
            tsConfig.compilerOptions.paths={};
        }
        /** @type {Record<string,string[]>} */
        const paths=tsConfig.compilerOptions.paths;
        let changed=false;

        if(paths[pkg.npmName]){
            const index=Path.join(pkg.dest,pkg.indexPath??'');
            const included=paths[pkg.npmName].indexOf(index)
            if(included!==-1){
                console.info(`removeTsPath: ${pkg.npmName}::${index}`);
                paths[pkg.npmName].splice(index,1);
                changed=true;
                if(paths[pkg.npmName].length===0){
                    delete paths[pkg.npmName];
                }
            }
        }

        if(!dryRun && changed){
            await fs.writeFile(tsConfigFile,JSON.stringify(tsConfig,null,4));
        }

    }

    if(!pkg.disableNpmPackageUpdate && pkg.npmName && current){
        const packageJson=await loadJsonOrDefaultAsync(packageJsonFile,{});
        const deps=packageJson.dependencies;
        const devDeps=packageJson.devDependencies;
        let changed=false;
        if(!current.isNpmDevDep && !deps?.[current.npmName]){
            console.info(`addNpmDep: ${current.npmName}@${current.installedNpmVersion}`);
            if(!deps){
                deps=packageJson.dependencies={}
            }
            deps[current.npmName]=current.installedNpmVersion;
            changed=true;
        }
        if(current.isNpmDevDep && !devDeps?.[current.npmName]){
            console.info(`addNpmDevDep: ${current.npmName}@${current.installedNpmVersion}`);
             if(!devDeps){
                devDeps=packageJson.devDependencies={}
            }
            devDeps[current.npmName]=current.installedNpmVersion;
            changed=true;
        }
        sortRecordKeys(deps);
        sortRecordKeys(devDeps);

        if(changed){
            packageJsonFileChanged=true;
            if(!dryRun){
                await fs.writeFile(packageJsonFile,JSON.stringify(packageJson,null,4));
            }
        }

    }


    if(currentIndex!==-1){
        currentPackages.splice(currentIndex,1);
    }
    if(!dryRun){
        if(!currentPackages.length){
            if(await existsAsync(currentPkgFile)){
                await fs.unlink(currentPkgFile);
            }
        }else{
            await fs.writeFile(currentPkgFile,JSON.stringify(currentPackages,null,4));
        }
    }

    // delete dir


    if(destExists){
        console.info(`rmdir: ${pkg.dest}`);
        if(!dryRun){
            await fs.rmdir(pkg.dest,{recursive:true});
        }
    }


}

/**
 * 
 * @param {string|null|undefined} npmName 
 * @param {Config} config 
 * @returns 
 */
const isInPublishScope=(npmName,config)=>{
    if(!npmName){
        return false;
    }
    const ns=config.namespace?config.namespace+'/':'//';
    return (
        config.excludeNamespaceFromBuildList?
            config.publishList?.includes(npmName):
            (config.publishList?.includes(npmName) || npmName?.startsWith(ns) || config.additionalNamespaces?.includes(npmName))
    )?true:false;
}

/**
 * @param {string[]|undefined} publishNames 
 */
const publishPackagesAsync=async (publishNames)=>{
    await loadBuildPackagesAsync();

    const publishList=publishNames?buildPkgs.filter(p=>publishNames.includes(p.dir)):buildPkgs;

    /** @type {Config} */
    const config=await loadJsonOrDefaultAsync(pkijConfigFileName,{});

    const newPkgs=[];
    prePublish: for(let i=0;i<publishList.length;i++){
        const pkg=publishList[i];
        if(!pkg){
            continue;
        }
        const version=pkg.packageJson.version;
        if( pkg.disablePublish ||
            !pkg.npmName ||
            !version ||
            !isInPublishScope(pkg.npmName,config)
        ){
            publishList.splice(i,1);
            i--;
            continue;
        }

        /** @type {Config} */
        const pkConfig=await loadJsonOrDefaultAsync(Path.join(pkg.dir,pkijConfigFileName),{});
        if((pkConfig.type??'lib')!=='lib'){
            publishList.splice(i,1);
            i--;
            continue;
        }

        console.log(`https://registry.npmjs.org/${pkg.npmName}`)
        const r=await fetch(`https://registry.npmjs.org/${pkg.npmName}`);
        const isNew=r.status===404;

        if(isNew){
            console.log(`new package ${pkg.npmName}@${version}`);
            newPkgs.push(pkg);
            continue;
        }

        if(!r.ok){
            throw new Error(`unable to get npm package for ${pkg.npmName}`)
        }

        const info=await r.json();


        if(info.versions[version]){
            console.log(`${pkg.npmName}@${version} already published`);
            publishList.splice(i,1);
            i--;
            continue;
        }

        const distTags=info['dist-tags']
        if(distTags){
            for(const e in distTags){
                if(distTags[e]===version){
                    console.log(`${pkg.name}@${version} already published`);
                    publishList.splice(i,1);
                    i--;
                    continue prePublish;
                }
            }
        }
    }
//
    await spawnAsync({cmd:`npm config list`})

    console.log('\nPackages to be published:\n-------------------------------------');
    for(const pkg of publishList){
        console.log(`${getPkgOut(pkg).outDir} -> ${pkg.npmName}@${pkg.packageJson.version}${newPkgs.includes(pkg)?' (new)':''}`);
    }
    console.log('-------------------------------------\n');

    if(!yes){
        const r=await promptYesNoAsync('Packages ready to publish. Would you like to continue?');
        if(!r){
            return;
        }
    }

    const rcName='.npmrc';
    const npmrcExists=await existsAsync(rcName);

    for(const pkg of publishList){
        const outDir=await fs.realpath(getPkgOut(pkg).outDir);
        console.log(`Publish ${outDir} -> ${pkg.npmName}@${pkg.packageJson.version}${newPkgs.includes(pkg)?' (new)':''}`);
        const cmd=`npm publish --access public --tag latest`;
        if(dryRun){
            console.log(`dry run: ${pkg.dir}> ${cmd}`);
        }else{
            if(npmrcExists){
                await fs.copyFile(rcName,Path.join(outDir,rcName));
            }
            try{
                await spawnAsync({
                    cwd:outDir,
                    cmd,
                })
            }finally{
                if(npmrcExists){
                    await fs.rm(Path.join(outDir,rcName));
                }
            }
        }
    }
}

/**
 * @param {string[]|true} tests 
 */
const runTestsAsync=async (tests)=>{
    await loadBuildPackagesAsync();
    /** @type {Pkg[]|undefined} */
    let packages;
    if(tests===true){
        packages=await getScopePackagesAsync();
    }else{
        packages=buildPkgs.filter(p=>tests.includes(p.dir));
    }

    const outBaseDir='./.pkij/tests';

    if(!dryRun){
        await fs.rm(outBaseDir,{recursive:true,force:true});
    }

    await Promise.all(packages.map(p=>buildTestAsync(p,outBaseDir)));

    await spawnAsync({
        cmd:`npx jest --rootDir '${outBaseDir}'`
    });

}

/**
 * @param {Pkg} pkg 
 * @param {string} outBaseDir
 */
const buildTestAsync=async (pkg,outBaseDir)=>{
    const outdir=Path.join(outBaseDir,pkg.dir);
    const files=[];
    await scanDirAsync(pkg.dir,outdir,(file,srcPath)=>{
        if(file.endsWith('.test.ts') || file.endsWith('.spec.ts')){
            files.push(srcPath);
        }
    });
    if(!files.length){
        console.log(`No test found for ${pkg.dir}`);
        return;
    }
    console.log(`Test files for ${pkg.dir}`,files);
    await fs.mkdir(outdir,{recursive:true});
    await esbuildAsync({
        pkg,
        outdir,
        files,
    })
}

/**
 * @return {Promise<Pkg[]>} 
 */
const getScopePackagesAsync=async ()=>{
    await loadBuildPackagesAsync();
    const config=await loadJsonOrDefaultAsync(pkijConfigFileName,{});
    return buildPkgs.filter(p=>isInPublishScope(p.npmName,config));
}

/**
 * @param {string} version 
 */
const setVersionAsync=async (version)=>{
    /** @type {Config} */
    const config=await loadJsonOrDefaultAsync(pkijConfigFileName,{});
    const dirs=await fs.readdir('./packages');
    for(const dir of dirs){
        const packageJsonPath=Path.join('./packages',dir,'package.json');
        await setPackageVersionAsync(version,packageJsonPath,config,false);
    }
    await setPackageVersionAsync(version,'package.json',config,true);
}

/**
 * @param {string} version
 * @param {string} packageJsonPath
 * @param {Config} config
 * @param {boolean} ignoreScope
 */
const setPackageVersionAsync=async (version,packageJsonPath,config,ignoreScope)=>{
    const pkg=await loadJsonOrDefaultAsync(packageJsonPath,false);
    if(pkg===false || !pkg.name || !(ignoreScope?true:isInPublishScope(pkg.name,config))){
        return;
    }

    if(!pkg.version){
        pkg.version='0.0.0';
    }
    const ov=pkg.version;

    if(version.startsWith('+')){
        pkg.version=addVersions(pkg.version,version.substring(1));
    }else{
        pkg.version=version;
    }

    console.log(`${pkg.name} ${ov} -> ${pkg.version}`);
    if(!dryRun){
        await fs.writeFile(packageJsonPath,JSON.stringify(pkg,null,4));
    }

}

const addVersions=(a,b)=>{
    const aAry=a.split('.').map(n=>Number(n));
    const bAry=b.split('.').map(n=>Number(n));
    return `${(aAry[0]??0)+(bAry[0]??0)}.${(aAry[1]??0)+(bAry[1]??0)}.${(aAry[2]??0)+(bAry[2]??0)}`
}

const tsConfigReg=/^tsconfig\./i;

const migrateNxTsConfigAsync=async ()=>{
    const defaultTsConfig=JSON.stringify({
        extends:"../../tsconfig.base.json",
        include:["src/**/*.ts","src/**/*.tsx"],
        exclude:[
            "jest.config.ts","src/**/*.spec.ts",
            "src/**/*.test.ts","src/**/*.spec.tsx",
            "src/**/*.test.tsx"
        ]
    },null,4);

    const dirs=await fs.readdir('./packages',{withFileTypes:true});
    for(const d of dirs){
        if(!d.isDirectory()){
            continue;
        }

        const dir=Path.join('./packages',d.name);

        const files=await fs.readdir(dir,{withFileTypes:true});
        let removed=false;
        for(const file of files){
            if(!file.isDirectory() && tsConfigReg.test(file.name)){
                removed=true;
                const filePath=Path.join(dir,file.name);
                console.log(`rm ${filePath}`);
                if(!dryRun){
                    await fs.rm(filePath);
                }
            }
        }
        if(removed){
            const tsPath=Path.join(dir,'tsconfig.json');
            console.log(`write ${tsPath}`);
            if(!dryRun){
                await fs.writeFile(tsPath,defaultTsConfig);
            }
        }
    }
    
    await loadBuildPackagesAsync();
    await updateTsConfigsAsync();
}

const hasExtReg=/\.(js|jsx|ts|tsx|mjs|mts|cts|cjs)$/i;

/**
 * @param {string} path
 */
const updateImportsAsync=async (path)=>{
    await scanDirAsync(path,path,async (name,destPath,srcPath,isDir)=>{
        if(isDir || !tsReg.test(name)){
            return;
        }
        let file=await loadTextAsync(srcPath);
        file=file.replace(importReg,(_,_type,iName)=>{
            if(!iName.startsWith('.') || hasExtReg.test(iName)){
                return _;
            }
            console.log(srcPath,'->',_.replace(iName,iName+'.js'));
            return _.replace(iName,iName+'.js');
            
        }).replace(requireReg,(_,type,iName)=>{
            if(!iName.startsWith('.') || hasExtReg.test(iName)){
                return _;
            }
            console.log(type,srcPath,'->',_.replace(iName,iName+'.js'));
            return _.replace(iName,iName+'.js');
        });
        if(!dryRun){
            await fs.writeFile(destPath,file);
        }

    });
}

/**
 * @param {string} path
 * @returns {string}
 */
const normPath=(path)=>{
    return path.replace(/\\/g,'/');
}

/**
 * package paths to build
 * @type {string[]}
 */
const buildPaths=[];

/**
 * package paths to build
 * @type {Pkg[]}
 */
const buildPkgs=[];
let rootBuildPackageJson={};
let rootTsConfig={};
let buildDir='./';
let updateTsConfigs=false;
let buildIndividualPackages=false;

const updateTsConfigsAsync=async ()=>{

    await Promise.all(buildPkgs.map(async pkg=>{
        if(!pkg.tsConfig || !pkg.tsConfigPath){
            return;
        }
        if(!pkg.tsConfig.compilerOptions){
            pkg.tsConfig.compilerOptions={};
        }
        const refs=[];
        if(pkg.deps){
            for(const dep of pkg.deps){
                const depPkg=buildPkgs.find(p=>p.npmName===dep);
                if(depPkg){
                    refs.push({path:joinPaths('../..',depPkg.dir)})
                }
            }
        }
        refs.sort((a,b)=>a.path.localeCompare(b.path));
        pkg.tsConfig.references=refs;
        pkg.tsConfig.compilerOptions.composite=true;
        if(dryRun){
            console.log(`${pkg.tsConfigPath} = ${JSON.stringify(pkg.tsConfig,null,4)}`)
        }else{
            await fs.writeFile(pkg.tsConfigPath,JSON.stringify(pkg.tsConfig,null,4));
        }
    }));

    const rootTsPath='./tsconfig.json';
    const rootTsConfig=await loadJsonOrDefaultAsync(rootTsPath,{});
    if(!rootTsConfig.files){
        rootTsConfig.files=[];
    }
    rootTsConfig.references=buildPkgs.map(p=>({path:'./'+p.dir}));
    rootTsConfig.references.sort((a,b)=>a.path.localeCompare(b.path));
    if(dryRun){
        console.log(`${rootTsPath} = ${JSON.stringify(rootTsConfig,null,4)}`);
    }else{
        await fs.writeFile(rootTsPath,JSON.stringify(rootTsConfig,null,4));
    }
}

let buildPackagesLoaded=false;
const loadBuildPackagesAsync=async ()=>{

    if(buildPackagesLoaded){
        return;
    }
    buildPackagesLoaded=true;

    rootBuildPackageJson=await loadJsonAsync('./package.json');
    rootTsConfig=await loadJsonOrDefaultAsync('./tsconfig.base.json');
    buildDir=normPath(process.cwd());
    if(!buildDir.endsWith('/')){
        buildDir+='/';
    }

    const dirs=await getBuildPackagePathsAsync();
    await Promise.all(dirs.map(async path=>{
        const pkg={dir:path}
        await populatePkgAsync(pkg,true);
        buildPkgs.push(pkg);
    }));

    await Promise.all(buildPkgs.map(pkg=>populatePkgPass2Async(pkg,rootBuildPackageJson,rootTsConfig)));
}

const listDepsAsync=async ()=>{

    await loadBuildPackagesAsync();
    const all=[];
    for(const pkg of buildPkgs){
        console.log(`---------------------------------------`);
        console.log(`${pkg.dir} (${pkg.deps.length} / ${pkg.externalDeps.length})`);
        console.log('Internal:');
        for(const dep of pkg.deps){
            console.log(dep);
            if(!all.includes(dep)){
                all.push(dep);
            }
        }
        console.log('External:');
        for(const dep of pkg.externalDeps){
            console.log(dep);
            if(!all.includes(dep)){
                all.push(dep);
            }
        }
    }
    console.log(`---------------------------------------`);
    console.log(`All:`);
    for(const dep of all){
        console.log(dep);
    }
}

const cleanProjectAsync=async ()=>{
    const rm=async (path)=>{
        console.log(`${dryRun?'dry run> ':''}rm -rf '${path}'`);
        if(!dryRun){
            await fs.rm(path,{recursive:true,force:true});
        }
    }
    const dirs=await fs.readdir('packages');
    await Promise.all([
        rm('.pkij'),
        rm('.next'),
        rm('dist'),
        ...dirs.map(async d=>{
            const dir=Path.join('packages',d);
            const nextDir=Path.join(dir,'.next');
            const cdkDir=Path.join(dir,'cdk.out');
            if(await existsAsync(nextDir)){
                await rm(nextDir);
            }
            if(await existsAsync(cdkDir)){
                await rm(cdkDir);
            }
        })

    ])
}

const buildAsync=async ()=>{

    const startTime=Date.now();

    await loadBuildPackagesAsync();

    await updateTsConfigsAsync();

    const max=1000;
    const working=[];

    if(!buildIndividualPackages){
        const buildCmd=`npx tsc --build`;
        if(dryRun){
            console.log(`dry run> ${buildCmd}`);
        }else{
            await spawnAsync({
                cmd:buildCmd,
            });
        }
    }

    const buildList=buildPkgs.filter(p=>buildPaths.includes(p.dir));
    for(const pkg of buildList){
        working.push(buildPackageAsync(pkg));

        if(working.length>=max){
            await Promise.all(working);
            working.splice(0,working.length);
        }
    }

    await Promise.all(working);

    console.log(`Build complete in ${(Date.now()-startTime).toLocaleString()}ms`)
}

/**
 * @returns {Promise<string[]>}
 */
const getBuildPackagePathsAsync=async ()=>{
    const buildPaths=[];
    const dirs=await fs.readdir('./packages',{withFileTypes:true});
    for(const d of dirs){
        if(d.isDirectory() && !ignoreList.includes(d.name) && await existsAsync(Path.join('./packages',d.name,'tsconfig.json'))){
            buildPaths.push(Path.join('packages',d.name));
        }
    }
    return buildPaths;
}

const importReg=/(import|export[ \t]+\*)\s+.*?\s*from\s+['"]([^'"]+)['"]/gs;
const requireReg=/\W(require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/gs;
const tsReg=/\.tsx?$/i

/**
 * @param {string} name
 * @returns {string}
 */
const formatImportName=(name)=>{
    const parts=name.split('/');
    return parts.length===1?parts[0]:parts[0].startsWith('@')?parts[0]+'/'+parts[1]:parts[0];
}

const assetsExtensions=[
    'md',
    'png',
    'jpg',
    'jpeg',
    'gif',
]

const invalidImportReg=/[\$\+'"`]/

/**
 * @param {string} content
 * @param {RegExp} reg
 * @param {number} matchI
 * @param {string[]} deps
 * @param {string[]} externalDeps
 * @param {Record<string,any>} rootBuildPackageJson
 * @param {Record<string,any>} rootTsConfig
 */
const findDeps=(content,reg,matchI,deps,externalDeps,rootBuildPackageJson,rootTsConfig)=>{
    content='\n'+content;
    let match;
    while(match=reg.exec(content)){
        const name=formatImportName(match[matchI])
        if(!name.startsWith('.') && !name.startsWith('@/') && !deps.includes(name)){
            if(!invalidImportReg.test(name)){
                if(isProjectDep(name,rootBuildPackageJson,rootTsConfig)){
                    deps.push(name);
                }else if(!externalDeps.includes(name)){
                    externalDeps.push(name);
                }
            }
        }
    }
}

/**
 * @param {string} name
 * @param {Record<string,any>} rootBuildPackageJson
 * @param {Record<string,any>} rootTsConfig
 */
const isProjectDep=(name,rootBuildPackageJson,rootTsConfig)=>{
    const isProjectDep=(
        (rootBuildPackageJson?.dependencies && (name in rootBuildPackageJson.dependencies)) ||
        (rootBuildPackageJson?.devDependencies && (name in rootBuildPackageJson.devDependencies)) ||
        (rootBuildPackageJson?.peerDependencies && (name in rootBuildPackageJson.peerDependencies)) ||
        (rootTsConfig?.compilerOptions?.paths && (name in rootTsConfig.compilerOptions.paths))
    )?true:false;
    return isProjectDep;
}

const getPkgOut=(pkg)=>{
    const outBaseDir=Path.join(
        pkg.dir,
        pkg.tsConfig?.compilerOptions?.outDir??'../../dist'
    );
    const outDir=Path.join(
        outBaseDir,
        pkg.dir,
    );
    return {outBaseDir,outDir}
}

/**
 * Builds a package
 * @param {Pkg} pkg
 */
const buildPackageAsync=async (pkg)=>{

    if(pkg.config?.build?.disabled || pkg.config?.disabled){
        return;
    }

    if(verbose){
        console.log('Build Package',pkg);
    }

    const {outBaseDir,outDir}=getPkgOut(pkg);

    if(buildIndividualPackages && (pkg.config?.type??'lib')==='lib'){
        await buildLibAsync(pkg);
    }

    if(pkg.binDir){
        await buildBinAsync(pkg);
    }

    const packageJson=pkg.packageJson;
    const [outExists,srcExists,indexExists]=await Promise.all([
        existsAsync(outDir),
        existsAsync(Path.join(outDir,'src')),
        existsAsync(Path.join(outDir,'src/index.js')),
    ])
    if(!packageJson.main && indexExists){
        packageJson.main='./src/index.js';
    }
    if(packageJson.sideEffects===undefined){
        packageJson.sideEffects=false;
    }

    if(!dryRun && outExists){
        await Promise.all([
            fs.writeFile(Path.join(outDir,'package.json'),JSON.stringify(packageJson,null,4)),
            srcExists?fs.writeFile(Path.join(outDir,'src/package.json'),'{"sideEffects":false}'):null,
            ...(pkg.assets?.map(a=>copyAsync(a,Path.join(outBaseDir,a)))??[])
        ]);
    }

}

const copyAsync=async (src,dest)=>{
    const dir=Path.dirname(dest);
    if(!await existsAsync(dir)){
        await fs.mkdir(dir,{recursive:true})
    }
    await fs.copyFile(src,dest);
}

/**
 * Builds a package as a library
 * @param {Pkg} pkg
 */
const buildLibAsync=async (pkg)=>{

    const tsConfig=pkg.tsConfig;
    if(!tsConfig || !pkg.tsConfigPath){
        return;
    }

    await buildEsPackageAsync(pkg);
}

const nodeExternals=['path','fs','events','readline','http','os','stream','child_Process','inspector','fsevents']
const esBuildConfigBase={
    bundle:true,
    platform:"node",
    target:"node20",
    minify:false,
    format:'cjs',
    sourcemap:"external",
    external:['node:*',...nodeExternals],
    'tree-shaking':true,
}

/**
 * Builds a package as an executable
 * @param {Pkg} pkg
 */
const buildBinAsync=async (pkg)=>{
    if(!pkg.tsConfigPath || !pkg.binDir){
        return;
    }

    const files=(
        (await fs.readdir(pkg.binDir))
        .filter(f=>f.toLowerCase().endsWith('.ts') || f.toLowerCase().endsWith('.js'))
        .map(f=>Path.join(pkg.binDir,f))
    )
    if(!files.length){
        return;
    }

    const {outBaseDir}=getPkgOut(pkg);
    
    await esbuildAsync({
        pkg,
        outdir:Path.join(outBaseDir,pkg.dir,'bin'),
        clearOut:true,
        files,
        addBinsToPackageJson:true,
        esBuildOptions:{"banner:js":"#!/usr/bin/env node",...pkg.binBuildOptions}
    });
}

/**
 * @typedef EsBuildOptions
 * @prop {Pkg} pkg
 * @prop {string} outdir
 * @prop {boolean|undefined} clearOut
 * @prop {string[]} files
 * @prop {boolean|undefined} addBinsToPackageJson
 * @prop {Record<string,any>|undefined} esBuildOptions
 */

/**
 * 
 * @param {EsBuildOptions} param0 
 */
const esbuildAsync=async ({pkg,outdir,clearOut,files,addBinsToPackageJson,esBuildOptions})=>{

    if(!dryRun && clearOut){
        await fs.rm(outdir,{recursive:true,force:true});
        await fs.mkdir(outdir,{recursive:true});
    }

    outdir=await fs.realpath(outdir);
    const config={
        ...esBuildConfigBase,
        outdir,
        external:[...esBuildConfigBase.external,...(pkg.externalDeps??[])],
        ...esBuildOptions,
    }

    try{
        const start=Date.now();
        const cmd=`npx esbuild ${files.join(' ')} ${objToArts(config)}`;
        if(dryRun){
            console.log(`dry run> ${cmd}`);
        }else{
            await spawnAsync({
                cwd:pkg.dir,
                cmd,
            });
            if(addBinsToPackageJson && !pkg.packageJson.bin){
                pkg.packageJson.bin={}
                const files=await fs.readdir(outdir);
                for(const f of files){
                    if(f.endsWith('.js')){
                        pkg.packageJson.bin[f.substring(0,f.length-3)]=`bin/${f}`;
                    }
                }
            }
        }

        console.log(`${pkg.dir} complete - ${(Date.now()-start).toLocaleString()}ms`)
    }catch(ex){
        console.error(`Failed to build bin ${pkg.binDir}`,ex);
        throw ex;
    }
}

const objToArts=(obj)=>{
    let args=[];
    for(const e in obj){
        const v=obj[e];
        if(Array.isArray(v)){
            for(const value of v){
                args.push(`'--${e}:${escapeCliArg(value)}'`);
            }
        }else{
            args.push(`'--${e}=${escapeCliArg(v)}'`);
        }
    }
    return args.join(' ');
}

const escapeCliArg=(arg)=>{
    return (arg?.toString()??'').replace(/'/g,"\\'");
}


/**
 * Builds a package
 * @param {Pkg} pkg
 */
const buildEsPackageAsync=async (pkg)=>{
    if(!pkg.tsConfigPath){
        return;
    }
    console.log(`Build ${pkg.dir}`);
    if(verbose){
        console.log(pkg);
    }
    let start=Date.now();
    
    try{
        const cmd=`npx tsc --project '${Path.basename(pkg.tsConfigPath)}'`;
        if(dryRun){
            console.log(`dry run> ${cmd}`);
        }else{
            await spawnAsync({
                cwd:pkg.dir,
                cmd,
            })
        }

        console.log(`${pkg.dir} complete - ${(Date.now()-start).toLocaleString()}ms`)
    }catch(ex){
        console.error(`Failed to build ${pkg.dir}`,ex);
        throw ex;
    }

}

const nameReg=/[\w-]/;

/**
 * @param {string} name 
 */
const createLibAsync=async (name)=>{
    if(!nameReg.test(name)){
        throw new Error('Invalid library name');
    }

    const dir=Path.join('packages',name);
    if(await existsAsync(dir)){
        throw new Error(`Lib directory already exists - ${dir}`);
    }
    /** @type {Config} */
    const config=await loadJsonOrDefaultAsync(pkijConfigFileName,{});

    const npmName=`${config.namespace}/${name}`

    /** @type {Record<string,string>} */
    const files={
        'tsconfig.json':`
{
    "extends": "../../tsconfig.base.json",
    "include": [
        "src/**/*.ts",
        "src/**/*.tsx"
    ],
    "exclude": [
        "jest.config.ts",
        "src/**/*.spec.ts",
        "src/**/*.test.ts",
        "src/**/*.spec.tsx",
        "src/**/*.test.tsx"
    ],
    "compilerOptions": {}
}
        `,
        'packages.json':`
{
    "name": "${npmName}",
    "version": "0.0.0",
    "type": "module",
    "sideEffects": false
}
        `,
        'src/index.ts':`export * from './lib/example.js';`,
        'src/lib/example.ts':`export const exampleExport=true;`,
        
    };

    if(!dryRun){
        await fs.mkdir(dir,{recursive:true});
    }

    for(const e in files){
        const path=Path.join(dir,e);
        const value=files[e].trim()+'\n';
        if(dryRun){
            console.log(path,'->',value);
        }else{
            console.log(`write ${path}`);
            await fs.mkdir(Path.dirname(path),{recursive:true});
            await fs.writeFile(path,value);
        }
    }

    const tsConfigBase=await loadJsonOrDefaultAsync('tsconfig.base.json',{});
    if(!tsConfigBase.compilerOptions){
        tsConfigBase.compilerOptions={};
    }
    if(!tsConfigBase.compilerOptions.paths){
        tsConfigBase.compilerOptions.paths={};
    }
    tsConfigBase.compilerOptions.paths[npmName]=[Path.join(dir,'src/index.ts')];
    const copy={}
    const keys=Object.keys(tsConfigBase.compilerOptions.paths);
    keys.sort();
    for(const e of keys){
        copy[e]=tsConfigBase.compilerOptions.paths[e];
    }
    tsConfigBase.compilerOptions.paths=copy;
    if(dryRun){
        console.log(`tsconfig.base.json -> ${JSON.stringify(tsConfigBase,null,4)}`);
    }else{
        console.log(`write tsconfig.base.json`);
        await fs.writeFile('tsconfig.base.json',JSON.stringify(tsConfigBase,null,4));
    }

}

const showUsage=()=>{
    console.log(`Usage:
    
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

--clear-env                     Clears all loaded env files including defaults. (note) The position
                                of this argument is important and only clears envs loaded before
                                the positions of this argument.

--clean                         Clears the dist, .pkij and all .next directories

--yes                           Answers yes for all interactive prompts 

--verbose                       If present verbose logging will be enabled.`)
}



const bsReg=/\\/g;
const doubleSlashReg=/\/{2,}/g;
const sdsReg=/\/\.\//g;
const parentDirReg=/(^|\/)[^\/]+\/\.\.(\/|$)/g;
/**
 * @param {string} path 
 * @returns {string}
 */
const normalizePath=(path)=>{
    while(true){
        const n=_normalizePath(path);
        if(n===path){
            return n;
        }
        path=n;
    }
}

/**
 * @param {string} path 
 * @returns {string}
 */
const _normalizePath=(path)=>{
    const proto=protocolReg.exec(path)?.[0]??'';
    if(proto){
        path=path.substring(proto.length);
    }
    if(path.includes('\\')){
        path=path.replace(bsReg,'/');
    }
    if(path.includes('/./')){
        path=path.replace(sdsReg,'/');
    }
    if(path.endsWith('/.')){
        path=path.substring(0,path.length-1);
    }
    if(path.includes('//')){
        path=path.replace(doubleSlashReg,'/');
    }
    if(path==='/'){
        return proto+path;
    }
    if(path.endsWith('/')){
        path=path.substring(0,path.length-1);
    }
    if(path.includes('..')){
        path=path.replace(parentDirReg,'/');
    }
    if(!path){
        path='.';
    }
    return proto+path;
}

/**
 * @param {...string[]} paths
 * @returns {string}
 */
const joinPaths=(...paths)=>
{
    if(!paths){
        return '';
    }
    let path=paths[0];
    if(path.endsWith('/')){
        path=path.substring(0,path.length-1);
    }
    for(let i=1;i<paths.length;i++){
        const part=paths[i];
        if(!part){
            continue;
        }
        path+=(part[0]==='/'?'':'/')+part;
        if(path.endsWith('/')){
            path=path.substring(0,path.length-1);
            if(!path){
                path='/';
            }
        }
    }
    return path;
}

(async ()=>{
    try{
        await main();
    }catch(ex){
        console.error('pkij failed',ex);
        process.exit(1);
    }
})()
