#!/usr/bin/perl

# archiveimap.pl
# $Id: archiveimap.pl,v 1.6 2008/09/16 18:28:38 kcraig Exp $

# Sample YAML for the ~/.archiveimaprc file
# test:
#  imaphost: yourimapserver.domain.com
#  auth: netrc
# # username : imapusername #will also be used for netrc lookup if given
# # password : imappassword #leave blank for netrc
#  archiveroot: Archives
#  archiverange: quarter # none, year, quarter, month, day
#  sourcefolder:
#   - folder : INBOX
#     age    : 60
#     seen   : 1			# 1=only move "seen" messages
#     action : archive		# archive or delete
#   - folder : Sent Items
#     age    : 30
#     seen   : 1
#     action : archive
#   - folder : SPAM
#     age    : 14
#     seen   : 0
#     ignorebaddates : YES #0/1 will not work, must be YES to ignore
#     action : delete

# requires some cpan installs
# sudo cpan YAML
# sudo cpan Mail::IMAPClient


#use Strict;

use Getopt::Std;
use POSIX qw(strftime);
use Mail::IMAPClient::BodyStructure;
use Mail::IMAPClient;
use Email::Address;
use Data::Dumper;
use Date::Parse;
use YAML qw(Bless Dump);
use Net::Netrc;
use Domain::PublicSuffix;
use Pod::Usage;

my $debug = 0;

sub connectImap {
	my ($imapserver, $user, $pass, $authmech, $ssl, $port, $debug) = @_;
	my $imap;
	if ($port) {
		$imap = Mail::IMAPClient->new(Server=>$imapserver, User=>$user, Password=>$pass, Authmechanism=>$authmech, Ssl=>$ssl, Port=>$port, Debug=>$debug);
	} else {
		$imap = Mail::IMAPClient->new(Server=>$imapserver, User=>$user, Password=>$pass, Authmechanism=>$authmech, Ssl=>$ssl, Debug=>$debug);
	}
	return $imap;
}

getopts('hvtx');

$hash=YAML::LoadFile($ENV{HOME}."/.archiveimaprc");

$argc = @ARGV;
print "argv count ",$argc, "\n";

if (($opt_h) || ($argc == 0)) {
	@keys=keys(%$hash);
	#print "Your archiveimap.rc file contains the following sources:\n";
	#print "\t", join("\n\t", @keys), "\n";
	pod2usage(-message => "Your archiveimap.rc file contains the following sources:\n\t".join("\n\t", @keys)."\n", -verbose  => 1);
	exit;
}

if ($opt_t) {
	print "---------- SAFE MODE ----------\n";
}

$now = time;
$thisyear = strftime("%Y", localtime($now + 60*60*24*7)); # next week's year really, just for edge case

foreach $server (@ARGV) {
	print "Processing $server\n";
	$node = $hash->{$server};

	my $imapserver = $node->{imaphost};
	# by default, use the username/password defined in the config
	$user = $node->{username};
	$pass = $node->{password};
	$authmech = "LOGIN";
	if ( $node->{auth} eq 'md5' ) {
 		$authmech = "CRAM-MD5";
	}

	unless ($user && $pass) {
		$opt_v && print STDERR ".netrc lookup for $imapserver and $user\n";
		if ($host = Net::Netrc->lookup($imapserver, $user)) {
			if (! $user) {
				$user = $host->login;
			}
			if (! $pass) {
				$pass = $host->password;
			}
		} else {
			print STDERR "ERROR: $imapserver not found in .netrc.\n";
			next;
		}
	}

	unless ($user && $pass) {
		print STDERR "ERROR: I don't seem to have a username/password for $server\n";
		next;
	}

	my $folderroot = $node->{archiveroot};

	my $port = $node->{imapport};
	my $ssl = $node->{imapssl};
	my $imap = connectImap($imapserver, $user, $pass, $authmech, $ssl, $port, $debug);
	# if ($port) {
	# 	$imap = Mail::IMAPClient->new(Server=>$imapserver, User=>$user, Password=>$pass, Authmechanism=>$authmech, Ssl=>$ssl, Port=>$port, Debug=>$debug);
	# } else {
	# 	$imap = Mail::IMAPClient->new(Server=>$imapserver, User=>$user, Password=>$pass, Authmechanism=>$authmech, Ssl=>$ssl, Debug=>$debug);
	# }
	if ( $imap ) {

		$opt_v && print "Available Folders: ", join("\n",$imap->folders),"\n";

		unless ($sepChar = $imap->separator() ) {
			print STDERR "ERROR: Could not get separator: $@\n";
			next;
		}
		$opt_v && print "The folder separator is $sepChar\n";

		$folderlist = $node->{sourcefolder};
		foreach $foldernode (@$folderlist) {
			$folder = $foldernode->{folder};
			unless ($imap->select($folder)) {
				print STDERR "ERROR: cannot select the folder $folder for $user: $@\n";
				next;
			}

			$archiverange = $node->{archiverange};
			if ($foldernode->{archiverange}) {
				$archiverange = $foldernode->{archiverange};
			}
			if ($archiverange !~ /^(none|year|quarter|month|day|to|from)$/) {
				$opt_v && print "Invalid range ($archiverange).  Skipping Folder.\n";
				next;
			}

			my $action = lc($foldernode->{action});
			if ( $action =~ /^(archive|delete)$/ ) {
				$opt_v && print "I will $action items in folder $folder.\n";
			} else {
				print STDERR "ERROR: Invalid Action ($action).  Skipping $server.\n";
				next;
			}

			$ignorebaddates = 0;
			if ((lc($foldernode->{ignorebaddates}) eq 'yes') || (lc($node->{ignorebaddates}) eq 'yes')) {
				$ignorebaddates = 1;
				$opt_v && print "Ignoring bad dates for $folder\n";
			}

			my $age = $node->{age};
			if ($foldernode->{age}) {
				$age = $foldernode->{age};
			}

			if ($age eq "ALL") {
				$searchtime = $now + (60*60*24);
				$opt_v && print "ALL messages selected.\n";
			} elsif ( $age < 0 ) {
				print STDERR "ERROR: Age is zero or negative.  Skipping $server.\n";
				next;
			} else {
				$opt_v && print "Age is $age\n";
				$searchtime = $now - (60*60*24)*$age; # hey slackass, go look up the better way to do this
			}
			$searchstr = Mail::IMAPClient->Rfc2060_date($searchtime);
			$opt_v && print "Age for $folder is $age days, $searchstr\n";

			if ( $foldernode->{seen} ) {
				$opt_v && print "Searching $folder for READ messages before $searchstr\n";
				@recent = $imap->search("SEEN NOT DELETED SENTBEFORE $searchstr");
			} else {
				$opt_v && print "Searching $folder for ALL messages before $searchstr\n";
				@recent = $imap->search("NOT DELETED SENTBEFORE $searchstr");
			}

			$opt_v && print "Search found ", scalar(@recent), " items\n";
			$moveditems = 0;
			$totalitems = scalar(@recent);
			foreach my $message (@recent) {
				my $subject = $imap->subject($message);
				my $send_date = $imap->date($message);

				###############
				# Add to/from sorting
				# get just the base from the email address
				###############

				my $to_header = $imap->get_header($message, "To");
				my @to_addrs = Email::Address->parse($to_header);
				my %to_hash;
				@to_hash{@to_addrs} = (); #make a hash with keys from the @to_addrs array
				if (scalar(@to_addrs) > 1) {
					$to_address = $to_addrs[0]; # just default to the first one in case we don't find a match in the headers
					# if multiple "to" addresses, loop try to locate one of them in the "Received"
					$opt_v && print STDERR "Found MANY addresses\n";
					my $received_header = $imap->parse_headers($message, "Received");
					my $received_headers = $received_header->{"Received"};
					foreach $header (@$received_headers) {
						#print "Received_header is ", $header, "\n";
						my @header_emails = Email::Address->parse($header);
						if (scalar(@header_emails)) {
							my $header_address = $header_emails[0]->address;
							if (exists($to_hash{$header_address})) {
								$to_address = $header_emails[0];
								$opt_v && print STDERR "\tTHIS MESSAGE IS TO $header_address\n";
								last;
							}
						}
					}
				} elsif (scalar(@to_addrs) == 1) {
					$opt_v && print STDERR "Found ONE address\n";
					$to_address = $to_addrs[0];

				} else {
					$opt_v && print STDERR "Found NO addresses\n";
					 $to_address = Email::Address->new(undef, "INVALID_TO@invalidaddress.com");
				}

				$opt_v && print STDERR "To: ", $to_address->address, "\n";
				$opt_v && print STDERR "\tTo User: ", $to_address->user, "\n";
				$opt_v && print STDERR "\tTo Host: ", $to_address->host, "\n";

				my $from_address = Email::Address->new(undef, $imap->get_header($message, "From"));
				my $domainSuffix = Domain::PublicSuffix->new();
				my $from_domain = $domainSuffix->get_root_domain($from_address->host);

				$opt_v && print STDERR "From: ", $from_address->address, "\n";
				$opt_v && print STDERR "\tFrom User: ", $from_address->user, "\n";
				$opt_v && print STDERR "\tFrom Host: ", $from_address->host, "\n";
				$opt_v && print STDERR "\tFrom Host Domain: ", $from_domain, "\n";

				my $time = str2time($send_date);
				($ss,$mm,$hh,$day,$month,$year,$zone) = strptime($send_date);
				$year += 1900;
				$quarter = "Q".(int($month/3)+1);
				$month = sprintf("%02d", ++$month);
				if ($year < 1980 || $year > $thisyear) {
					$opt_v && print STDERR "WARNING: Message year ($year) is outside of range.\n";
					$opt_v && print STDERR "\tSUBJECT: $subject\n";
					$year = "";
				}
				if ($month < 1 || $month > 12) {
					$opt_v && print STDERR "WARNING: Message month ($month) is invalid.\n";
					$opt_v && print STDERR "\tSUBJECT: $subject\n";
					$month = "";
					$quarter = "";
				}
				if ($day < 1 || $day > 31) {
					$opt_v && print STDERR "WARNING: Message day ($day) is invalid.\n";
					$opt_v && print STDERR "\tSUBJECT: $subject\n";
					$day = "";
				}
				if ($archiverange eq 'none') {
					$destination=$folderroot;
				} elsif (($archiverange eq 'year') && $year ) {
					$destination=join($sepChar, $folderroot, $year, $folder);
				} elsif (($archiverange eq 'quarter') && $year && $quarter ){
					$destination=join($sepChar, $folderroot, $year, "$folder-$quarter");
				} elsif (($archiverange eq 'month') && $year && $month ) {
					$destination=join($sepChar, $folderroot, $year, $month, $folder);
				} elsif (($archiverange eq 'day') && $year && $month && $day) {
					$destination=join($sepChar, $folderroot, $year, $month, $day, $folder);
				} elsif (($archiverange eq "to") && $to_address) {
					$destination=join($sepChar, $folderroot, lc($to_address->user));
				} elsif (($archiverange eq "from") && $from_domain) {
					$destination=join($sepChar, $folderroot, $year, lc($from_domain));
				} elsif ( $ignorebaddates ) {
					$destination=join($sepChar, $folderroot, "$folder-Archive-BadDate");
					$opt_v && print STDERR "WARNING: Invalid Date Part, Filing in $destination\n";
				} else {
					$opt_v && print STDERR "WARNING: Skipping the bad date.\n";
					next;
				}
				if ( $ignorebaddates || ($time < $searchtime) ) {
					if ($action eq "archive") {
						$opt_v && print "Moving $message, $send_date to $destination\n";
						$moveditems++;
						if (! $opt_t) {
							if ($imap->Unconnected()) {
								$opt_v && print "Reconnecting for Move\n";
								$imap = connectImap($imapserver, $user, $pass, $authmech, $ssl, $port, $debug) or last;
							}
							$imap->move("$destination", $message)
								or last;
						}
					} elsif ($action eq "delete") {
						$opt_v && print "Deleting $message, $subject\n";
						$moveditems++;
						if (! $opt_t) {
							if ($imap->Unconnected()) {
								$opt_v && print "Reconnecting for Delete\n";
								$imap = connectImap($imapserver, $user, $pass, $authmech, $ssl, $port, $debug) or last;
							}
							$imap->delete_message($message)
								or last;
						}
					}

				} else {
					$opt_v && print "Keeping $send_date newer than $searchstr\n";
				}
			}
			print "Folder $folder: moved $moveditems out of $totalitems\n";
			if ($opt_x) { # don't do it as an "and" for better messaging
				print "Expunging deleted items from folder $folder.\n";
				if (! $opt_t) {
					if ($imap->Unconnected()) {
						$opt_v && print "Reconnecting for Purge\n";								
						$imap = connectImap($imapserver, $user, $pass, $authmech, $ssl, $port, $debug) or last;
					}
					$imap->expunge();
				}
			} else {
				print "Retaining deleted items in folder $folder.\n";
			}
		}
	} else {
		print STDERR "ERROR: Could not connect to IMAP server $imapserver\n";
	}
}

__END__
=head1 NAME

archiveimap.pl

=head1 SYNOPSIS

archiveimap.pl -[htvx] [imapsource ...]

Use B<perldoc archiveimap.pl> to view complete documentation and example configuration.

=head1 REQUIREMENTS

Requires Perl modules Mail::IMAPClient (v3.35 tested) and YAML (v1.13 tested) modules.

=over

$ sudo cpan Mail::IMAPClient YAML

=back

=head1 OPTIONS

=over 4

=item B<-h>

Print this help message

=item B<-v>

Use verbose messaging during execution

=item B<-t>

Execute the script in SAFE Mode - no changes applied.  Usually used with -v to verify expected results.

=item B<-x>

Purge deleted items at end of run

=item B<imapsource ...>
list of mail server(s) to be archived.  This must match sources listed in the .archiveimaprc configuration

=back

=head1 DESCRIPTION

B<imaparchive.pl> uses your ~/.archiveimaprc configuration and,
for each imapsource provided, archive the email in the specified
folders according to the criteria given.

=head1 ~/.archiveimaprc
B<~/.archiveimaprc> is a YAML configuration file

=over 4

=item B<accountname>: Nickname of a source mail account

=over

=item B<imaphost>: hostname of the imap server

=item B<imapssl>: 0 or 1 use SSL for connection?

=item B<imapport>: port number to connect to (if not provided, default to 143 when imapssl=0 or 993 when imapssl=1)

=item B<auth>: password|netrc|md5|cert - authentication type (only password and netrc work)

=item B<username>: password - required for auth=password

=over

=item Optional for auth=netrc to select a specific instance of imaphost

=back

=item B<password>: password - required for auth=password, not for netrc

=item B<archiveroot>: root_folder - destination root folder for the archives

=item B<sourcefolder>: start the list of sourcefolders (literally the word sourcefolder)

=over

=item B<- folder>: sourcename - source folder for archiving (defaults to INBOX), must be exact name

=over

=item B<action>: archive|delete - specifies the action to take for this folder

=item B<archiverange>: year|quarter|month|day|to|from - defines the archive directory structure format

=over

=item year = root.sourcename-yyyy directories

=item quarter = root.yyyy.sourcename-Q[1-4] directories

=item month = root.yyyy.sourcename-[01-12] directories

=item day = root.yyyy.mm.sourcename-[01-31] directories

=item to = root.sourcename.{basename of the "to" address}

=over

=item -If there are multiple B<To:> addresses in the message header, then an attempt is made to identify which of these addresses was used to actually deliver the message by searching the B<Received:> for an email address that matches one of the B<To:> addresses.

=item -Only the B<User> portion of the email address is used for the folder name, so bob@example.com will be filed into a directory named "bob".

=item -Folder names are always converted to lowercase

=back

=item from = root.sourcename.{basename of the "from" address} (Not yet implemented)

=back

=item B<age>: days - minimum age of messages to be archived

=over

=item If "0", then don't archive anything
=item If "ALL", then archive all messages, regardless of date

=back

=item B<seen>: 0|1 - archive only "seen" messages? default=1

=item B<ignorebaddates>: YES|NO - Delete messages with invalid dates?  Only valid for "delete" actin default=NO

=back

=back

=back

=back

=head1 CONFIGURATION EXAMPLE

The following configuration for the imapsource B<exchange> would archive items in the folder INBOX
that have been read and are 30 days or older.  These would be copied into the imap directory
/Archives/YYYY/INBOX-Q# where YYYY and Q# are the year and quarter of the mail item's date.

Items in the same server, folder SPAM that are 30 days or older, whether they've been
read or not, and any items in that folder which have invalid dates would be marked for deletion.  If
the -x option was specified then these would be purged from the folder permanently.

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


=cut
