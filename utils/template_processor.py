#!/usr/bin/env python3
"""
Template processor for replacing {{ variable }} placeholders with actual values.

Usage:
    python template_processor.py --var1 value1 --var2 value2
    python template_processor.py --config config.yaml
"""

import argparse
import re
import sys
import yaml
from pathlib import Path
from typing import Dict, Any, Optional, List


class TemplateProcessor:
    """Processes template files with {{ variable }} placeholders."""
    
    def __init__(self):
        self.variable_pattern = re.compile(r'\{\{\s*([^}]+)\s*\}\}')
    
    def extract_variables(self, content: str) -> set:
        """Extract all variables from template content."""
        return {var.strip() for var in self.variable_pattern.findall(content)}
    
    def process_content(self, content: str, variables: Dict[str, Any]) -> str:
        """
        Process template content, replacing {{ variable }} with actual values.
        
        Args:
            content: Template content as string
            variables: Dictionary of variable names to values
            
        Returns:
            Processed content with variables replaced
        """
        def replace_variable(match):
            var_name = match.group(1).strip()
            if var_name in variables:
                return str(variables[var_name])
            else:
                print(f"Warning: Variable '{var_name}' not found in provided variables", file=sys.stderr)
                return match.group(0)  # Keep original if not found
        
        return self.variable_pattern.sub(replace_variable, content)
    
    def process_file(self, input_file: Path, output_file: Path, variables: Dict[str, Any], in_place: bool = False) -> None:
        """
        Process a template file and write the result to output file.
        
        Args:
            input_file: Path to input template file
            output_file: Path to output file
            variables: Dictionary of variable names to values
            in_place: If True, overwrite the input file
        """
        try:
            with open(input_file, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Extract variables found in template
            template_vars = self.extract_variables(content)
            
            # Skip if no variables found
            if not template_vars:
                if not in_place:
                    print(f"No variables found in {input_file}, skipping")
                return
            
            # Process the content
            processed_content = self.process_content(content, variables)
            
            # Write to output file
            with open(output_file, 'w', encoding='utf-8') as f:
                f.write(processed_content)
            
            if in_place:
                print(f"Processed {input_file} in place")
            else:
                print(f"Successfully processed {input_file} -> {output_file}")
            
            # Show which variables were replaced
            replaced_vars = set(variables.keys()) & template_vars
            if replaced_vars:
                print(f"  Replaced variables: {sorted(replaced_vars)}")
            
            # Show which variables were not found
            missing_vars = template_vars - set(variables.keys())
            if missing_vars:
                print(f"  Warning: Variables not found in provided values: {sorted(missing_vars)}")
                
        except FileNotFoundError:
            print(f"Error: Input file '{input_file}' not found", file=sys.stderr)
            sys.exit(1)
        except Exception as e:
            print(f"Error processing file: {e}", file=sys.stderr)
            sys.exit(1)
    
    def find_template_files(self, root_dir: Path, extensions: List[str] = None) -> List[Path]:
        """
        Find all files that might contain template variables.
        
        Args:
            root_dir: Root directory to search
            extensions: List of file extensions to include (default: common config extensions)
            
        Returns:
            List of file paths that contain template variables
        """
        if extensions is None:
            extensions = ['values.yaml', 'values.yml', '.json', '.txt', '.conf', '.cfg', '.ini', '.env', '.sh', '.py', '.md']
        
        template_files = []
        
        for file_path in root_dir.rglob('*'):
            if file_path.is_file() and file_path.suffix.lower() in extensions:
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        content = f.read()
                    
                    # Check if file contains template variables
                    if self.variable_pattern.search(content):
                        template_files.append(file_path)
                except (UnicodeDecodeError, PermissionError):
                    # Skip binary files or files we can't read
                    continue
        
        return sorted(template_files)
    
    def process_all_files(self, root_dir: Path, variables: Dict[str, Any], in_place: bool = True, 
                         extensions: List[str] = None, exclude: List[str] = None) -> None:
        """
        Process all template files in a directory tree.
        
        Args:
            root_dir: Root directory to search
            variables: Dictionary of variable names to values
            in_place: If True, overwrite files in place
            extensions: List of file extensions to include
            exclude: List of directory names to exclude
        """
        if exclude is None:
            exclude = ['.git', '__pycache__', 'node_modules', '.venv', 'venv', '.github', '.vscode', '.gitignore', 'utils', 'mytra-helm-charts.yaml', '.gitignore', 'template_processor.py']
        
        # Find all template files
        template_files = self.find_template_files(root_dir, extensions)
        
        # Filter out files in excluded directories
        filtered_files = []
        for file_path in template_files:
            if not any(exclude_item in file_path.parts for exclude_item in exclude):
                filtered_files.append(file_path)
        
        if not filtered_files:
            print("No template files found with variables to replace")
            return
        
        print(f"Found {len(filtered_files)} files with template variables:")
        for file_path in filtered_files:
            print(f"  {file_path.relative_to(root_dir)}")
        
        print(f"\nProcessing files {'in place' if in_place else 'to output directory'}...")
        
        processed_count = 0
        for file_path in filtered_files:
            try:
                if in_place:
                    self.process_file(file_path, file_path, variables, in_place=True)
                else:
                    # For non-in-place processing, you'd need to specify output directory
                    print(f"Error: Non-in-place processing requires output directory specification")
                    return
                processed_count += 1
            except Exception as e:
                print(f"Error processing {file_path}: {e}", file=sys.stderr)
                continue
        
        print(f"\nSuccessfully processed {processed_count} files")


def load_config_file(config_file: Path) -> Dict[str, Any]:
    """Load variables from a YAML config file."""
    try:
        with open(config_file, 'r', encoding='utf-8') as f:
            return yaml.safe_load(f) or {}
    except FileNotFoundError:
        print(f"Error: Config file '{config_file}' not found", file=sys.stderr)
        sys.exit(1)
    except yaml.YAMLError as e:
        print(f"Error parsing YAML config file: {e}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Process template files with {{ variable }} placeholders",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Process all files with command line variables
  python template_processor.py --site hil --subdomain hil --dns_recursive_nameservers 10.100.192.11:53 \\
    --nodes '[]' --ads_net_id 10.100.200.10.1.1 --twin_cat_host 10.100.200.10 \\
    --metallb_address_range_start 10.100.202.40 --metallb_address_range_end 10.100.202.49 \\
    --nfs_server 10.100.202.30
  
  # Process all files with config file
  python template_processor.py --config variables.yaml
  
  # Dry run to see what would be replaced
  python template_processor.py --dry-run --site hil --subdomain hil
        """
    )
    
    parser.add_argument('--config', '-c', type=Path, help='YAML config file with variables')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be replaced without writing output')
    parser.add_argument('--extensions', nargs='+', help='File extensions to process (default: yaml,yml,json,txt,conf,cfg,ini,env,sh,py)')
    parser.add_argument('--exclude', nargs='+', help='Directories and files to exclude (default: .git,__pycache__,node_modules,.venv,venv, utils, github, .vscode, mytra-helm-charts.yaml, .gitignore)')
    # Parse known args to separate variables from other arguments
    args, unknown = parser.parse_known_args()
    
    # Parse variables from command line (format: --var_name value)
    cli_variables = {}
    i = 0
    while i < len(unknown):
        if unknown[i].startswith('--'):
            var_name = unknown[i][2:]  # Remove '--'
            if i + 1 < len(unknown) and not unknown[i + 1].startswith('--'):
                cli_variables[var_name] = unknown[i + 1]
                i += 2
            else:
                cli_variables[var_name] = True  # Boolean flag
                i += 1
        else:
            i += 1
    
    # Load variables from config file if provided
    config_variables = {}
    if args.config:
        config_variables = load_config_file(args.config)
    
    # Merge variables (config file values override CLI values)
    variables = {**cli_variables, **config_variables}
    
    if not variables:
        print("Error: No variables provided. Use --config or provide variables with --var_name value", file=sys.stderr)
        sys.exit(1)
    
    # Create processor
    processor = TemplateProcessor()
    
    # Process all files
    root_dir = Path.cwd()
    extensions = args.extensions
    exclude = args.exclude
    
    if args.dry_run:
        # Dry run for all files
        template_files = processor.find_template_files(root_dir, extensions)
        if exclude:
            template_files = [f for f in template_files if not any(exclude_item in f.parts for exclude_item in exclude)]
        
        print(f"Found {len(template_files)} files with template variables:")
        for file_path in template_files:
            print(f"  {file_path.relative_to(root_dir)}")
        
        print(f"\nVariables provided: {sorted(variables.keys())}")
        print("\nDry run - showing what would be replaced:")
        
        for file_path in template_files:
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                template_vars = processor.extract_variables(content)
                if template_vars:
                    print(f"\n{file_path.relative_to(root_dir)}:")
                    for var in sorted(template_vars):
                        if var in variables:
                            print(f"  {var} -> {variables[var]}")
                        else:
                            print(f"  {var} -> [NOT PROVIDED]")
            except Exception as e:
                print(f"Error reading {file_path}: {e}")
    else:
        # Process all files in place
        processor.process_all_files(root_dir, variables, in_place=True, 
                                  extensions=extensions, exclude=exclude)


if __name__ == '__main__':
    main()
