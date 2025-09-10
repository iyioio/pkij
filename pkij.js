#!/usr/bin/env node
"use strict";

const child_process = require("node:child_process");
const fs = require("node:fs/promises");
const Path = require("node:path");

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
 * @prop {string[]} deps Direct package dependencies
 * @prop {Config|undefined} config additional configuration
 *
 * @typedef Config
 * @prop {'lib'|'nextjs'|'cdk'|'test'|undefined} type
 * @prop {Pkg[]|undefined} packages
 * @prop {string[]|undefined} ignore
 * @prop {BuildConfig|undefined} build
 * @prop {boolean|undefined} disabled
 *
 * @typedef BuildConfig
 * @prop {boolean|undefined} disabled
 */

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

    const addToAsync=async (dic,path)=>{
        /** @type {Pkg[]} */
        const pkgs=await getPkgsAsync(path);
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

        switch(process.argv[i]){

            case '--inject':
                hasAction=true;
                if(nextAll.length){
                    for(const n of nextAll){
                        await addToAsync(inject,n);
                    }
                }else{
                    await addToAsync(inject,'pkij-config.json');
                }
                break;

            case '--eject':
                hasAction=true;
                if(nextAll.length){
                    for(const n of nextAll){
                        await addToAsync(eject,n);
                    }
                }else{
                    await addToAsync(eject,'pkij-config.json');
                }
                break;

            case '--build':
                hasAction=true;
                const dirs=nextAll.length?nextAll.map(d=>(!d.includes('/') && !d.includes('\\'))?'packages/'+d:d):await getBuildPackagePathsAsync();
                for(const d of dirs){
                    if(!buildPaths.includes(d)){
                        buildPaths.push(d);
                    }
                }
                break;
            case '--build-no-swc':
                buildUseSwc=false;
                break;

            case '--build-peer-internal-only':
                buildPeerInternalOnly=true;
                break;

            case '--update-imports':
                if(next){
                    updateImports=next;
                    hasAction=true;
                }
                break;

            case '--dry-run':
            case '--dryRun':
                dryRun=true;
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

        }
    }

    if(!hasAction){
        showUsage();
        process.exit(1);
    }

    console.info('pkij config',{
        dryRun,
        verbose,
        packageJsonFile,
        gitIgnoreFile,
        tsConfigFile,
        ignoreList,
        skipNpmInstall,
        buildPaths,
    })

    for(const absPath in inject){
        await injectAsync(inject[absPath]);
    }

    for(const absPath in eject){
        await ejectAsync(eject[absPath]);
    }

    if(buildPaths.length){
        await buildAsync();
    }

    if(updateImports){
        await updateImportsAsync(updateImports);
    }

    if(packageJsonFileChanged && !skipNpmInstall){
        console.info('Changes to package.json made. Running npm install')
        if(!dryRun){
            await execAsync('npm',['install']);
        }
    }

    console.log('pkij done');
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
        stdout,
        stderr,
        onChild,
        onOutput,
        onError,
        outPrefix='',
        throwOnError=true,
        onExit,
        cancel,
        logPid,
    }=options;

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
                if(!silent){
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
            if(code && throwOnError){
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
const getPkgsAsync=async (path)=>{

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
            for(const pkg of config.packages){
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
    if(await existsAsync(packageJsonPath)){
        const packageJson=await loadJsonAsync(packageJsonPath);
        if((typeof packageJson.name === 'string') && !pkg.npmName){
            pkg.npmName=packageJson.name;
        }
        pkg.packageJson=packageJson;
    }
    const configPath=Path.join(pkg.dir,'pkij-config.json');
    if(await existsAsync(configPath)){
        const configJson=await loadJsonAsync(configPath);
        pkg.config=configJson;
    }
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
 */
const populatePkgDepsAsync=async (pkg)=>{
    const deps=await getPackagesDeps(pkg);

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
let buildDir='./'
const buildAsync=async ()=>{

    const startTime=Date.now();

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

    await Promise.all(buildPkgs.map(pkg=>populatePkgDepsAsync(pkg)));

    const max=1000;
    const working=[];

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
        if(d.isDirectory() && !ignoreList.includes(d.name)){
            buildPaths.push(Path.join('packages',d.name));
        }
    }
    return buildPaths;
}

const importReg=/(import|export[ \t]+\*)\s+.*?\s*from\s+['"]([^'"]+)['"]/gs;
const requireReg=/\W(require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/gs;
const tsReg=/\.tsx?/i

/**
 * @param {string} name
 * @returns {string}
 */
const formatImportName=(name)=>{
    const parts=name.split('/');
    return parts.length===1?parts[0]:parts[0].startsWith('@')?parts[0]+'/'+parts[1]:parts[0];
}

/**
 * @param {string} content
 * @param {RegExp} reg
 * @param {number} matchI
 * @param {string[]} deps
 */
const findDeps=(content,reg,matchI,deps)=>{
    content='\n'+content;
    let match;
    while(match=reg.exec(content)){
        const name=formatImportName(match[matchI])
        if(!name.startsWith('.') && !name.startsWith('@/') && !deps.includes(name)){
            deps.push(name);
        }
    }
}

/**
 * Builds a package
 * @param {string} tsConfig
 * @param {Pkg} pkg
 * @returns {Promise<string[]>}
 */
const getPackagesDeps=async (pkg)=>{

    const deps=[];

    await scanDirAsync(pkg.dest,pkg.dir,async (name,destPath,srcPath,isDir)=>{
        if(isDir || !tsReg.test(name) || name.includes('.spec.')){
            return;
        }
        const file=await loadTextAsync(srcPath);
        findDeps(file,importReg,2,deps);
        findDeps(file,requireReg,2,deps);

    });

    deps.sort();

    return deps;
}

/**
 * Builds a package
 * @param {Pkg} pkg
 */
const buildPackageAsync=async (pkg)=>{

    if(pkg.config?.build?.disabled || pkg.config?.disabled || (pkg.config?.type??'lib')!=='lib'){
        return;
    }

    const tsConfigPath=Path.join(pkg.dir,'tsconfig.json');

    const tsConfigExists=await existsAsync(tsConfigPath);
    if(!tsConfigExists){
        return;
    }

    const tsConfig=await loadJsonAsync(tsConfigPath);

    await buildEsPackageAsync({tsConfigPath,pkg,tsConfig});

    const outDir=Path.join(
        pkg.dir,
        tsConfig?.compilerOptions?.outDir??'../../dist',
        pkg.dir,
    );

    const packageJson={...pkg.packageJson}
    if(!packageJson.main && await existsAsync(Path.join(outDir,'src/index.js'))){
        packageJson.main='./src/index.js'
    }

    await Promise.all([
        fs.writeFile(Path.join(outDir,'package.json'),JSON.stringify(packageJson,null,4)),
        fs.writeFile(Path.join(outDir,'src/package.json'),'{"sideEffects":false}'),
    ]);
}

/**
 * @typedef EsBuildOptions
 * @prop {string} tsConfigPath Location of tsconfig file
 * @prop {string|undefined} outSuffix directory added to out path
 * @prop {Pkg} pkg package to build
 * @prop {Record<string,any>} tsConfig tsconfig contents
 */

let buildUseSwc=true;
/**
 * Builds a package
 * @param {EsBuildOptions} options
 */
const buildEsPackageAsync=async ({tsConfigPath,pkg,outSuffix,tsConfig})=>{
    console.log(`Build ${pkg.dir}`);
    console.log(pkg);
    let start=Date.now();
    
    try{
        if(buildUseSwc){

            
            const swcConfigDir=Path.join(outDir,'.swc',pkg.dir);
            const swcConfig=Path.join(swcConfigDir,'swc-config.json');
            const [exists]=await Promise.all([
                existsAsync(Path.join(pkg.dir,swcConfig)),
                fs.mkdir(Path.join(pkg.dir,swcConfigDir),{recursive:true}),
            ]);
            await spawnAsync({
                cwd:pkg.dir,
                cmd:(
                    (exists?'':`npx tsconfig-to-swcconfig -f './${Path.basename(tsConfigPath)}' -o '${swcConfig}' && `)+
                    `npx swc src --config-file '${swcConfig}' --out-dir '${Path.join(outDir,pkg.dir)}'`
                ),
            })
        }else{
            await spawnAsync({
                cwd:pkg.dir,
                cmd:(
                    `npx tsc --project '${Path.basename(tsConfigPath)}'`
                ),
                stderr:console.error,
                stdout:console.log
            })
        }

        console.log(`${pkg.dir} complete - ${(Date.now()-start).toLocaleString()}ms`)
    }catch(ex){
        console.error(`Failed to build ${pkg.dir}`,ex);
        throw ex;
    }

}

const showUsage=()=>{
    console.log(`Usage:
    
--inject        [path ...]      List of package source config files or paths to package directories to inject.
                        If no paths are provided a default value of "pkij-config.json" is used.


--eject         [path ...]      List of package source config files or paths to package directories to eject.
                                If no paths are provided a default value of "pkij-config.json" is used.

--build         [path ...]      Builds a package
--build-no-swc                  Disables using swc

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

--verbose                       If present verbose logging will be enabled.`)
}

(async ()=>{
    try{
        await main();
    }catch(ex){
        console.error('pkij failed',ex);
        process.exit(1);
    }
})()
