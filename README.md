archive-imap
============

Moves IMAP hosted messages to structured archive directories, configurable per source directory.

ARCHIVEIMAP(1)        User Contributed Perl Documentation       ARCHIVEIMAP(1)



NAME
       archiveimap.pl

SYNOPSIS
       archiveimap.pl -[htvx] [imapsource ...]

       Use perldoc archiveimap.pl to view complete documentation and example
       configuration.

REQUIREMENTS
       Requires Perl modules Mail::IMAPClient (v3.35 tested) and YAML (v1.13
       tested) modules.

           $ sudo cpan Mail::IMAPClient YAML

OPTIONS
       -h  Print this help message

       -v  Use verbose messaging during execution

       -t  Execute the script in SAFE Mode - no changes applied.  Usually used
           with -v to verify expected results.

       -x  Purge deleted items at end of run

       imapsource ... list of mail server(s) to be archived.  This must match
       sources listed in the .archiveimaprc configuration

DESCRIPTION
       imaparchive.pl uses your ~/.archiveimaprc configuration and, for each
       imapsource provided, archive the email in the specified folders
       according to the criteria given.

~/.archiveimaprc ~/.archiveimaprc is a YAML configuration file
       accountname: Nickname of a source mail account
           imaphost: hostname of the imap server
           imapssl: 0 or 1 use SSL for connection?
           imapport: port number to connect to (if not provided, default to
           143 when imapssl=0 or 993 when imapssl=1)
           auth: password|netrc|md5|cert - authentication type (only password
           and netrc work)
           username: password - required for auth=password
               Optional for auth=netrc to select a specific instance of
               imaphost
           password: password - required for auth=password, not for netrc
           archiveroot: root_folder - destination root folder for the archives
           sourcefolder: start the list of sourcefolders (literally the word
           sourcefolder)
               - folder: sourcename - source folder for archiving (defaults to
               INBOX), must be exact name
                   action: archive|delete - specifies the action to take for
                   this folder
                   archiverange: year|quarter|month|day|to|from - defines the
                   archive directory structure format
                       year = root.sourcename-yyyy directories
                       quarter = root.yyyy.sourcename-Q[1-4] directories
                       month = root.yyyy.sourcename-[01-12] directories
                       day = root.yyyy.mm.sourcename-[01-31] directories
                       to = root.sourcename.{basename of the "to" address}
                           -If there are multiple To: addresses in the message
                           header, then an attempt is made to identify which
                           of these addresses was used to actually deliver the
                           message by searching the Received: for an email
                           address that matches one of the To: addresses.
                           -Only the User portion of the email address is used
                           for the folder name, so bob@example.com will be
                           filed into a directory named "bob".
                           -Folder names are always converted to lowercase
                       from = root.sourcename.{basename of the "from" address}
                       (Not yet implemented)
                   age: days - minimum age of messages to be archived
                       If "0", then don't archive anything =item If "ALL",
                       then archive all messages, regardless of date
                   seen: 0|1 - archive only "seen" messages? default=1
                   ignorebaddates: YES|NO - Delete messages with invalid
                   dates?  Only valid for "delete" actin default=NO

CONFIGURATION EXAMPLE
       The following configuration for the imapsource exchange would archive
       items in the folder INBOX that have been read and are 30 days or older.
       These would be copied into the imap directory /Archives/YYYY/INBOX-Q#
       where YYYY and Q# are the year and quarter of the mail item's date.

       Items in the same server, folder SPAM that are 30 days or older,
       whether they've been read or not, and any items in that folder which
       have invalid dates would be marked for deletion.  If the -x option was
       specified then these would be purged from the folder permanently.

       exchange:
        imaphost: exchangeserver.mydomain.com
        auth: netrc
        username:
        password:
        archiveroot: Archives
        archiverange: quarter
        sourcefolder:
         - folder : INBOX
           age    : 30
           seen   : 1
           action : archive
         - folder : SPAM
           age    : 30
           seen   : 0
           ignorebaddates : YES
           action : delete

       Then just use the nickname "exchange" when running
         $ archiveimap.pl -vx exchange



perl v5.12.4                      2014-12-04                    ARCHIVEIMAP(1)
