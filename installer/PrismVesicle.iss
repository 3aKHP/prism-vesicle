#ifndef AppVersion
  #error AppVersion must be supplied by scripts/build-installer.ts
#endif
#ifndef SourceRoot
  #error SourceRoot must be supplied by scripts/build-installer.ts
#endif
#ifndef FileVersion
  #error FileVersion must be supplied by scripts/build-installer.ts
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by scripts/build-installer.ts
#endif

#define AppName "Prism Vesicle"
#define SourceExeName "prism-vesicle.exe"
#define AppExeName "vesicle.exe"
#define AppPublisher "3aKHP"
#define AppUrl "https://github.com/3aKHP/prism-vesicle"

[Setup]
AppId={{C573D44C-8972-4F71-9027-BD0A1F6C9752}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
VersionInfoVersion={#FileVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} guided installer
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#FileVersion}
DefaultDirName={localappdata}\Programs\Prism Vesicle
DefaultGroupName=Prism Vesicle
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=PrismVesicleSetup-{#AppVersion}-windows-x64
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#AppExeName}
LicenseFile={#SourceRoot}\LICENSE
ChangesEnvironment=yes
CloseApplications=yes
RestartApplications=no
UsePreviousAppDir=yes
UsePreviousGroup=yes
ShowLanguageDialog=auto
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "languages\ChineseSimplified.isl"

[CustomMessages]
english.MaintenanceCaption=Prism Vesicle Maintenance
english.MaintenanceDescription=Choose how to maintain the existing installation.
english.MaintenanceSubCaption=Reinstall updates all installed files. Repair restores program integration without reopening Guided Setup. Uninstall starts the existing uninstaller.
english.MaintenanceReinstall=Reinstall / upgrade Prism Vesicle
english.MaintenanceRepair=Repair installed files and Windows integration
english.MaintenanceUninstall=Uninstall Prism Vesicle
english.MaintenanceUninstallFailed=The existing Prism Vesicle uninstaller could not be started:

[Files]
Source: "{#SourceRoot}\{#SourceExeName}"; DestDir: "{app}"; DestName: "{#AppExeName}"; Flags: ignoreversion
Source: "{#SourceRoot}\harness-manifest.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceRoot}\host-assets\*"; DestDir: "{app}\host-assets"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
Type: files; Name: "{app}\prism-vesicle.exe"
Type: files; Name: "{app}\vesicle.cmd"
Type: files; Name: "{group}\Prism Vesicle.lnk"

[Icons]
Name: "{group}\Configure Prism Vesicle"; Filename: "{app}\{#AppExeName}"; Parameters: "setup"; WorkingDir: "{userdocs}"
Name: "{group}\Prism Vesicle Doctor"; Filename: "{cmd}"; Parameters: "/k &quot;&quot;{app}\{#AppExeName}&quot; doctor&quot;"; WorkingDir: "{userdocs}"
Name: "{group}\Uninstall Prism Vesicle"; Filename: "{uninstallexe}"

[Registry]
Root: HKCU; Subkey: "Software\Classes\Directory\shell\PrismVesicle"; ValueType: string; ValueData: "Open in Prism Vesicle"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Directory\shell\PrismVesicle"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\{#AppExeName}"
Root: HKCU; Subkey: "Software\Classes\Directory\shell\PrismVesicle\command"; ValueType: string; ValueData: """{app}\{#AppExeName}"" ""%1"""
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\PrismVesicle"; ValueType: string; ValueData: "Open in Prism Vesicle"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\PrismVesicle"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\{#AppExeName}"
Root: HKCU; Subkey: "Software\Classes\Directory\Background\shell\PrismVesicle\command"; ValueType: string; ValueData: """{app}\{#AppExeName}"" ""%V"""

[Run]
Filename: "{app}\{#AppExeName}"; Parameters: "setup"; WorkingDir: "{userdocs}"; Description: "Configure and launch Prism Vesicle"; Flags: postinstall nowait skipifsilent; Check: ShouldLaunchGuidedSetup

[Code]
const
  UserEnvironmentKey = 'Environment';
  InstallerStateKey = 'Software\3aKHP\Prism Vesicle\Installer';
  ExistingUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{C573D44C-8972-4F71-9027-BD0A1F6C9752}_is1';
  PathManagedValue = 'PathManaged';

var
  MaintenancePage: TInputOptionWizardPage;
  ExistingUninstaller: String;
  MaintenanceOperation: Integer;
  MaintenanceExitRequested: Boolean;

function FindExistingUninstaller(var Filename: String): Boolean;
var
  UninstallCommand: String;
begin
  Result := RegQueryStringValue(HKCU, ExistingUninstallKey, 'UninstallString', UninstallCommand);
  if Result then
  begin
    Filename := RemoveQuotes(Trim(UninstallCommand));
    Result := FileExists(Filename);
  end;
end;

procedure InitializeWizard;
begin
  MaintenanceOperation := 0;
  MaintenanceExitRequested := False;
  if FindExistingUninstaller(ExistingUninstaller) and not WizardSilent then
  begin
    MaintenancePage := CreateInputOptionPage(
      wpWelcome,
      CustomMessage('MaintenanceCaption'),
      CustomMessage('MaintenanceDescription'),
      CustomMessage('MaintenanceSubCaption'),
      True,
      False);
    MaintenancePage.Add(CustomMessage('MaintenanceReinstall'));
    MaintenancePage.Add(CustomMessage('MaintenanceRepair'));
    MaintenancePage.Add(CustomMessage('MaintenanceUninstall'));
    MaintenancePage.SelectedValueIndex := 0;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  if (MaintenancePage <> nil) and (CurPageID = MaintenancePage.ID) then
  begin
    MaintenanceOperation := MaintenancePage.SelectedValueIndex;
    if MaintenanceOperation = 2 then
    begin
      Result := False;
      if Exec(ExistingUninstaller, '', '', SW_SHOW, ewNoWait, ResultCode) then
      begin
        MaintenanceExitRequested := True;
        WizardForm.Close;
      end
      else
        MsgBox(CustomMessage('MaintenanceUninstallFailed') + #13#10 + ExistingUninstaller, mbError, MB_OK);
    end;
  end;
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if MaintenanceExitRequested then
    Confirm := False;
end;

function ShouldLaunchGuidedSetup: Boolean;
begin
  Result := MaintenanceOperation <> 1;
end;

function NormalizePathEntry(Value: String): String;
begin
  Result := RemoveQuotes(Trim(Value));
  while (Length(Result) > 3) and (Result[Length(Result)] = '\') do
    Delete(Result, Length(Result), 1);
  Result := Lowercase(Result);
end;

function PathContains(PathValue: String; Entry: String): Boolean;
var
  Remaining: String;
  Part: String;
  Separator: Integer;
begin
  Result := False;
  Remaining := PathValue;
  while Remaining <> '' do
  begin
    Separator := Pos(';', Remaining);
    if Separator = 0 then
    begin
      Part := Remaining;
      Remaining := '';
    end
    else
    begin
      Part := Copy(Remaining, 1, Separator - 1);
      Delete(Remaining, 1, Separator);
    end;
    if NormalizePathEntry(Part) = NormalizePathEntry(Entry) then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

procedure AddToUserPath;
var
  CurrentPath: String;
  AppPath: String;
begin
  AppPath := ExpandConstant('{app}');
  if not RegQueryStringValue(HKCU, UserEnvironmentKey, 'Path', CurrentPath) then
    CurrentPath := '';
  if PathContains(CurrentPath, AppPath) then
    Exit;
  if (CurrentPath <> '') and (CurrentPath[Length(CurrentPath)] <> ';') then
    CurrentPath := CurrentPath + ';';
  if RegWriteExpandStringValue(HKCU, UserEnvironmentKey, 'Path', CurrentPath + AppPath) then
    RegWriteDWordValue(HKCU, InstallerStateKey, PathManagedValue, 1);
end;

procedure RemoveFromUserPath;
var
  CurrentPath: String;
  AppPath: String;
  Remaining: String;
  Part: String;
  NewPath: String;
  Separator: Integer;
  PathManaged: Cardinal;
begin
  PathManaged := 0;
  if not RegQueryDWordValue(HKCU, InstallerStateKey, PathManagedValue, PathManaged) or (PathManaged <> 1) then
    Exit;
  if not RegQueryStringValue(HKCU, UserEnvironmentKey, 'Path', CurrentPath) then
  begin
    RegDeleteValue(HKCU, InstallerStateKey, PathManagedValue);
    RegDeleteKeyIfEmpty(HKCU, InstallerStateKey);
    Exit;
  end;
  AppPath := ExpandConstant('{app}');
  Remaining := CurrentPath;
  NewPath := '';
  while Remaining <> '' do
  begin
    Separator := Pos(';', Remaining);
    if Separator = 0 then
    begin
      Part := Remaining;
      Remaining := '';
    end
    else
    begin
      Part := Copy(Remaining, 1, Separator - 1);
      Delete(Remaining, 1, Separator);
    end;
    if (Trim(Part) <> '') and (NormalizePathEntry(Part) <> NormalizePathEntry(AppPath)) then
    begin
      if NewPath <> '' then
        NewPath := NewPath + ';';
      NewPath := NewPath + Part;
    end;
  end;
  if RegWriteExpandStringValue(HKCU, UserEnvironmentKey, 'Path', NewPath) then
  begin
    RegDeleteValue(HKCU, InstallerStateKey, PathManagedValue);
    RegDeleteKeyIfEmpty(HKCU, InstallerStateKey);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    AddToUserPath;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RemoveFromUserPath;
end;
